import Dockerode from 'dockerode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Writable } from 'stream';
import { AgentConfig } from '../config.js';
import { readProcMountsCached } from '../fs/proc-mounts.js';
import {
  LABEL,
  NYABASE_NETWORK,
  SPEC_VERSION,
  ContainerSpec,
  ContainerStatsSummary,
  ImageRuntimeOverrides,
  allocateNextIp,
} from '@nyabase/common';
import { Mutex } from 'async-mutex';
import { SOCKET_PATH } from './daemon-manager.js';

const execFileAsync = promisify(execFile);

/** Thrown when a Docker API call exceeds its configured timeout. */
export class DockerTimeoutError extends Error {
  constructor(public readonly op: string, public readonly timeoutMs: number) {
    super(`Docker operation timed out after ${timeoutMs}ms: ${op}`);
    this.name = 'DockerTimeoutError';
  }
}

/**
 * Race a promise against a timeout. Rejects with `DockerTimeoutError` if the
 * underlying call does not settle in time. Used to keep the metrics loop and
 * other periodic tasks from being blocked indefinitely by a wedged dockerd.
 *
 * Note: the underlying promise is not actually cancelled — dockerode lacks
 * an abort hook for most methods. The point is to free the caller, not the
 * socket; dockerode's keep-alive HTTP agent will eventually time out on its
 * own once the daemon recovers.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, op: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DockerTimeoutError(op, ms)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

const TIMEOUT_STATS_MS = 10_000;
const TIMEOUT_INSPECT_MS = 5_000;
const TIMEOUT_LIST_MS = 10_000;
const PULL_HEARTBEAT_MS = 60_000;

export class DockerClient {
  readonly docker: Dockerode;
  private readonly ipMutex = new Mutex();

  constructor(private config: AgentConfig) {
    this.docker = new Dockerode({ socketPath: SOCKET_PATH });
  }

  async ensureMacvlanNetwork() {
    const networks = await this.docker.listNetworks({
      filters: { name: [NYABASE_NETWORK] },
    });
    if (networks.length > 0) return;

    console.log(`[Docker] Creating macvlan network ${NYABASE_NETWORK}`);
    await this.docker.createNetwork({
      Name: NYABASE_NETWORK,
      Driver: 'macvlan',
      Options: { parent: this.config.parentIface },
      IPAM: {
        Config: [
          {
            Subnet: this.config.macvlanCidr,
            Gateway: this.config.macvlanGateway,
          },
        ],
      },
    });
  }

  async allocateNextIp(cidr: string, reservedIps: string[]): Promise<string> {
    return this.ipMutex.runExclusive(async () => {
      const networkInfo = await this.docker.getNetwork(NYABASE_NETWORK).inspect();
      const usedIps = new Set<string>(
        Object.values(networkInfo.Containers ?? {}).map((c: { IPv4Address: string }) =>
          c.IPv4Address.split('/')[0],
        ),
      );

      const ip = allocateNextIp(cidr, usedIps, [
        ...reservedIps,
        this.config.macvlanGateway,
      ]);
      if (!ip) throw new Error('No IP available in CIDR');
      return ip;
    });
  }

  async listNyabaseContainers(): Promise<Dockerode.ContainerInfo[]> {
    return withTimeout(
      this.docker.listContainers({
        all: true,
        filters: { label: [`${LABEL.MANAGED}=true`] },
      }),
      TIMEOUT_LIST_MS,
      'listContainers(v2-managed)',
    );
  }

  async inspectContainer(dockerId: string): Promise<Dockerode.ContainerInspectInfo> {
    return withTimeout(
      this.docker.getContainer(dockerId).inspect(),
      TIMEOUT_INSPECT_MS,
      `inspect(${dockerId.slice(0, 12)})`,
    );
  }

  async createContainer(params: {
    name: string;
    imageRef: string;
    cpuMillis: number;
    memBytes: number;
    gpuIndices: number[];
    ip: string;
    sshServerEnabled: boolean;
    containerId: string;
    ownerId: string;
    imageId: string;
    runtimeOverrides: ImageRuntimeOverrides;
    serverId: string;
  }): Promise<string> {
    const labels: Record<string, string> = {
      [LABEL.MANAGED]: 'true',
      [LABEL.CONTAINER_ID]: params.containerId,
      [LABEL.SERVER_ID]: params.serverId,
      [LABEL.SPEC_GENERATION]: SPEC_VERSION,
    };

    const env: string[] = [];
    if (params.gpuIndices.length > 0) {
      env.push(`NVIDIA_VISIBLE_DEVICES=${params.gpuIndices.join(',')}`);
      env.push('NVIDIA_DRIVER_CAPABILITIES=all');
    }
    const deviceRequests: Dockerode.DeviceRequest[] = params.gpuIndices.length > 0
      ? [{
          Driver: 'nvidia',
          DeviceIDs: params.gpuIndices.map(String),
          Capabilities: [['gpu']],
        }]
      : [];

    const createOptions: Dockerode.ContainerCreateOptions = {
      name: `nyabase-${params.ownerId.slice(0, 8)}-${params.name}`,
      Image: params.imageRef,
      User: String(params.runtimeOverrides.uid),
      Entrypoint: params.runtimeOverrides.entrypoint ?? undefined,
      Cmd: params.runtimeOverrides.cmd ?? undefined,
      Labels: labels,
      Env: env,
      HostConfig: {
        NanoCpus: params.cpuMillis > 0 ? params.cpuMillis * 1_000_000 : 0,
        Memory: params.memBytes > 0 ? params.memBytes : 0,
        MemorySwap: params.memBytes > 0 ? params.memBytes : 0,
        Init: params.runtimeOverrides.init,
        Runtime: params.gpuIndices.length > 0 ? 'nvidia' : undefined,
        ...(deviceRequests.length > 0 && { DeviceRequests: deviceRequests }),
        NetworkMode: NYABASE_NETWORK,
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [NYABASE_NETWORK]: {
            IPAMConfig: { IPv4Address: params.ip },
          },
        },
      },
    };
    const container = await this.docker.createContainer(createOptions);

    return container.id;
  }

  async startContainer(dockerId: string): Promise<void> {
    try {
      await this.docker.getContainer(dockerId).start();
    } catch (err) {
      // 304: container already started — treat as success
      if ((err as { statusCode?: number }).statusCode === 304) return;
      throw err;
    }
  }

  async stopContainer(dockerId: string, timeoutSeconds = 10): Promise<void> {
    try {
      await this.docker.getContainer(dockerId).stop({ t: timeoutSeconds });
    } catch (err) {
      // 304: container already stopped — treat as success
      if ((err as { statusCode?: number }).statusCode === 304) return;
      throw err;
    }
  }

  async restartContainer(dockerId: string, timeoutSeconds = 10): Promise<void> {
    await this.docker.getContainer(dockerId).restart({ t: timeoutSeconds });
  }

  async removeContainer(dockerId: string, force = false): Promise<void> {
    try {
      await this.docker.getContainer(dockerId).remove({ force, v: false });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return;
      throw err;
    }
  }

  async exec(
    dockerId: string,
    cmd: string[],
    tty: boolean,
    onData: (data: string, isErr: boolean) => void,
    onEnd: (exitCode: number) => void,
  ): Promise<{ resize: (cols: number, rows: number) => void; kill: () => void; write: (data: string) => void }> {
    const exec = await this.docker.getContainer(dockerId).exec({
      Cmd: cmd,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: tty,
    });

    const stream = await exec.start({ hijack: true, stdin: true, Tty: tty });
    if (!tty) {
      // demuxStream needs Writable-like objects; cast to satisfy the dockerode type
      const stdout = { write: (d: Buffer) => onData(d.toString('base64'), false) } as unknown as NodeJS.WritableStream;
      const stderr = { write: (d: Buffer) => onData(d.toString('base64'), true) } as unknown as NodeJS.WritableStream;
      this.docker.modem.demuxStream(stream, stdout, stderr);
    } else {
      stream.on('data', (d: Buffer) => onData(d.toString('base64'), false));
    }

    let ended = false;
    const finish = async () => {
      if (ended) return;
      ended = true;
      try {
        const info = await withTimeout(exec.inspect(), TIMEOUT_INSPECT_MS, 'exec.inspect');
        onEnd(info.ExitCode ?? 0);
      } catch {
        onEnd(-1);
      }
    };
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', () => { /* surface via close/end */ });

    return {
      resize: (cols, rows) => exec.resize({ w: cols, h: rows }).catch(() => {}),
      kill: () => {
        // Closing the hijacked stream alone does NOT make the docker daemon
        // signal the in-container shell process: the exec keeps running with
        // its TTY held open by the daemon, leaving a zombie. We have to fetch
        // the host-side PID and signal it ourselves (the agent runs as root
        // on the host, so cross-PID-namespace signaling works fine).
        (async () => {
          try {
            const info = await withTimeout(exec.inspect(), TIMEOUT_INSPECT_MS, 'exec.inspect');
            const pid = info.Pid;
            if (pid && pid > 0) {
              try { process.kill(pid, 'SIGHUP'); } catch { /* already gone */ }
              // Escalate to SIGKILL if it doesn't exit quickly.
              setTimeout(() => {
                try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
              }, 800);
            }
          } catch { /* ignore inspect errors */ }
          try { stream.destroy(); } catch { /* ignore */ }
        })();
      },
      write: (data: string) => {
        if (stream.writable) stream.write(Buffer.from(data, 'base64'));
      },
    };
  }

  async execCapture(
    dockerId: string,
    cmd: string[],
    timeoutMs = 10_000,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const exec = await this.docker.getContainer(dockerId).exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });

    const stream = await exec.start({ Tty: false });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutChunks.push(Buffer.from(chunk));
        callback();
      },
    });
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        stderrChunks.push(Buffer.from(chunk));
        callback();
      },
    });
    this.docker.modem.demuxStream(stream, stdout, stderr);

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        stream.on('end', resolve);
        stream.on('close', resolve);
        stream.on('error', reject);
      }),
      timeoutMs,
      `exec(${dockerId.slice(0, 12)}:${cmd[0] ?? ''})`,
    );

    const info = await withTimeout(exec.inspect(), TIMEOUT_INSPECT_MS, 'exec.inspect');
    return {
      stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
      stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      exitCode: info.ExitCode ?? 0,
    };
  }

  async putFile(
    dockerId: string,
    containerPath: string,
    data: Buffer,
    mode = 0o644,
  ): Promise<void> {
    const dir = containerPath.slice(0, containerPath.lastIndexOf('/')) || '/';
    const fileName = containerPath.slice(containerPath.lastIndexOf('/') + 1);
    const tar = this.createSingleFileTar(fileName, data, mode);
    await withTimeout(
      this.docker.getContainer(dockerId).putArchive(tar, { path: dir }),
      30_000,
      `putArchive(${dockerId.slice(0, 12)}:${containerPath})`,
    );
  }

  async getGraphDriverDirs(dockerId: string): Promise<{ upperDir: string; workDir: string }> {
    const info = await this.inspectContainer(dockerId);
    const data = info.GraphDriver?.Data as Record<string, string> | undefined;

    // overlay2 driver (older Docker): UpperDir/WorkDir available in GraphDriver.Data
    if (data?.UpperDir) {
      return { upperDir: data.UpperDir, workDir: data.WorkDir ?? '' };
    }

    // Docker 29+ overlayfs driver (containerd snapshotter)
    // Strategy 1: parse /proc/mounts (works only while container is running)
    const possibleMountpoints = [
      `/var/lib/docker/rootfs/overlayfs/${dockerId}`,
      `${this.config.dockerRoot}/rootfs/overlayfs/${dockerId}`,
    ];
    try {
      const mounts = await readProcMountsCached();
      for (const line of mounts.split('\n')) {
        if (!line.includes('overlay ')) continue;
        const parts = line.split(' ');
        const mountPoint = parts[1];
        if (!possibleMountpoints.some((p) => mountPoint === p)) continue;
        const opts = parts[3] ?? '';
        const upperDir = opts.match(/upperdir=([^,\s]+)/)?.[1] ?? '';
        const workDir = opts.match(/workdir=([^,\s]+)/)?.[1] ?? '';
        if (upperDir) return { upperDir, workDir };
      }
    } catch {
      // /proc/mounts unavailable or container not running, fall through
    }

    // Strategy 2: use containerd CLI (ctr) to query snapshot mount info
    // Works even for stopped/exited containers as the snapshot persists
    try {
      const { stdout } = await execFileAsync('ctr', ['-n', 'moby', 'snapshots', 'mounts', '/dev/null', dockerId]);
      const upperDir = stdout.match(/upperdir=([^,\s]+)/)?.[1] ?? '';
      const workDir = stdout.match(/workdir=([^,\s]+)/)?.[1] ?? '';
      if (upperDir) return { upperDir, workDir };
    } catch {
      // ctr not available or snapshot not found
    }

    return { upperDir: '', workDir: '' };
  }

  /**
   * Pull an image with no hard timeout (large layers take arbitrarily long)
   * but with a watchdog that aborts if no progress event arrives for
   * PULL_HEARTBEAT_MS — usually a sign the daemon got stuck.
   */
  async pullImage(ref: string, onProgress?: (msg: string) => void): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let watchdog: NodeJS.Timeout | null = null;
      const armWatchdog = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          reject(new DockerTimeoutError(`pull(${ref}) progress`, PULL_HEARTBEAT_MS));
        }, PULL_HEARTBEAT_MS);
      };
      const stopWatchdog = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };

      armWatchdog();
      this.docker.pull(ref, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) { stopWatchdog(); return reject(err); }
        this.docker.modem.followProgress(
          stream,
          (err2: Error | null) => { stopWatchdog(); err2 ? reject(err2) : resolve(); },
          (event: { status?: string }) => { armWatchdog(); onProgress?.(event.status ?? ''); },
        );
      });
    });
  }

  async fetchContainerStats(dockerId: string): Promise<ContainerStatsSummary> {
    const statsData = await withTimeout(
      new Promise<Record<string, unknown>>((resolve, reject) => {
        this.docker.getContainer(dockerId).stats({ stream: false }, (err, data) => {
          if (err) reject(err);
          else resolve(data as unknown as Record<string, unknown>);
        });
      }),
      TIMEOUT_STATS_MS,
      `stats(${dockerId.slice(0, 12)})`,
    );
    return this.parseDockerStats(statsData);
  }

  async fetchContainerStatsWithGpuMem(
    dockerId: string,
    getGpuMemUsedMiB?: (dockerId: string) => Promise<Record<string, number>>,
  ): Promise<ContainerStatsSummary> {
    const stats = await this.fetchContainerStats(dockerId);
    if (!getGpuMemUsedMiB) return stats;

    try {
      return {
        ...stats,
        gpuMemUsedMiB: await getGpuMemUsedMiB(dockerId),
      };
    } catch {
      return stats;
    }
  }

  private parseDockerStats(stats: Record<string, unknown>): ContainerStatsSummary {
    const cpu = stats.cpu_stats as Record<string, unknown>;
    const preCpu = stats.precpu_stats as Record<string, unknown>;
    const mem = stats.memory_stats as Record<string, unknown>;
    const net = stats.networks as Record<string, { rx_bytes: number; tx_bytes: number }>;

    const cpuDelta =
      ((cpu.cpu_usage as Record<string, number>).total_usage ?? 0) -
      ((preCpu.cpu_usage as Record<string, number>).total_usage ?? 0);
    const cpuUsageNs = (cpu.cpu_usage as Record<string, number>).total_usage ?? 0;
    const systemDelta = ((cpu.system_cpu_usage as number) ?? 0) - ((preCpu.system_cpu_usage as number) ?? 0);
    const numCpus = (cpu.online_cpus as number) ?? 1;
    const cpuRatio = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus : 0;

    const netRx = Object.values(net ?? {}).reduce((a, v) => a + v.rx_bytes, 0);
    const netTx = Object.values(net ?? {}).reduce((a, v) => a + v.tx_bytes, 0);

    const blkio = (stats.blkio_stats as Record<string, Array<{ op: string; value: number }>>) ?? {};
    const blkStats = blkio.io_service_bytes_recursive ?? [];
    const blkRead = blkStats
      .filter((s) => s.op.toLowerCase() === 'read')
      .reduce((a, s) => a + s.value, 0);
    const blkWrite = blkStats
      .filter((s) => s.op.toLowerCase() === 'write')
      .reduce((a, s) => a + s.value, 0);

    return {
      cpuUsageRatio: cpuRatio,
      cpuUsageUsec: Math.floor(cpuUsageNs / 1_000),
      memUsedBytes: (mem.usage as number) ?? 0,
      memLimitBytes: (mem.limit as number) ?? 0,
      netRxBytes: netRx,
      netTxBytes: netTx,
      blockReadBytes: blkRead,
      blockWriteBytes: blkWrite,
      gpuMemUsedMiB: {},
    };
  }

  parseContainerSpec(labels: Record<string, string>, container?: Dockerode.ContainerInfo): ContainerSpec | null {
    const containerId = labels[LABEL.CONTAINER_ID];
    const serverId = labels[LABEL.SERVER_ID];
    if (!containerId || !serverId) return null;
    return {
      runtimeId: '',
      name: containerId,
      ownerId: '',
      imageId: '',
      cpuMillis: 0,
      memBytes: 0,
      gpuIndices: [],
      ip: this.ipFromContainerInfo(container),
      serverId,
      sshServerEnabled: false,
      dataDirs: [],
      createdAt: '',
      specVersion: labels[LABEL.SPEC_GENERATION] ?? '',
    };
  }

  private ipFromContainerInfo(container?: Dockerode.ContainerInfo): string {
    const networks = (container?.NetworkSettings?.Networks ?? {}) as Record<string, { IPAddress?: string }>;
    return networks[NYABASE_NETWORK]?.IPAddress
      || Object.values(networks).find((network) => typeof network.IPAddress === 'string' && network.IPAddress.trim() !== '')?.IPAddress
      || '';
  }

  private createSingleFileTar(fileName: string, data: Buffer, mode: number): Buffer {
    const header = Buffer.alloc(512, 0);
    this.writeTarString(header, fileName, 0, 100);
    this.writeTarOctal(header, mode, 100, 8);
    this.writeTarOctal(header, 0, 108, 8);
    this.writeTarOctal(header, 0, 116, 8);
    this.writeTarOctal(header, data.length, 124, 12);
    this.writeTarOctal(header, Math.floor(Date.now() / 1000), 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    this.writeTarString(header, 'ustar', 257, 6);
    this.writeTarString(header, '00', 263, 2);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    this.writeTarOctal(header, checksum, 148, 8);

    const paddingLength = (512 - (data.length % 512)) % 512;
    return Buffer.concat([
      header,
      data,
      Buffer.alloc(paddingLength, 0),
      Buffer.alloc(1024, 0),
    ]);
  }

  private writeTarString(buffer: Buffer, value: string, offset: number, length: number): void {
    buffer.write(value, offset, Math.min(Buffer.byteLength(value), length), 'utf-8');
  }

  private writeTarOctal(buffer: Buffer, value: number, offset: number, length: number): void {
    const raw = value.toString(8).padStart(length - 1, '0');
    buffer.write(raw.slice(-length + 1), offset, length - 1, 'ascii');
    buffer[offset + length - 1] = 0;
  }
}
