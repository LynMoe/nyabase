import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
import Dockerode from 'dockerode';
import { DockerDaemonState, LABEL, type DockerDaemonStatus } from '@nyabase/common';
import { runIsolatedCommand } from '../fs/isolated-command.js';
import {
  calculateDockerResourceLimitPlan,
  DOCKER_LIMIT_SLICE_NAME,
  DOCKER_LIMIT_SLICE_PATH,
  getHostResourceSnapshot,
  type DockerResourceLimitConfig,
  type DockerResourceLimitPlan,
} from './resource-limits.js';

const execFileAsync = promisify(execFile);

export const SOCKET_PATH = '/run/nyabase-agent/docker.sock';
export const NYABASE_DOCKER_UNIT_NAME = 'nyabase-docker.service';
const UNIT_NAME = NYABASE_DOCKER_UNIT_NAME;
const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}`;

/** Maximum wait time for dockerd socket to become reachable after start (ms) */
const SOCKET_WAIT_TIMEOUT_MS = 60_000;
const SOCKET_POLL_INTERVAL_MS = 500;
export const DAEMON_DOCKER_PROBE_TIMEOUT_MS = 5_000;

export function assertDockerDaemonIdentity(
  configuredRoot: string,
  info: { Driver?: string; DockerRootDir?: string },
): void {
  const liveRoot = typeof info.DockerRootDir === 'string'
    ? path.resolve(info.DockerRootDir)
    : null;
  const expectedRoot = path.resolve(configuredRoot);
  if (liveRoot !== expectedRoot) {
    throw new Error(`dockerd data-root mismatch: expected ${expectedRoot}, observed ${liveRoot ?? 'missing'}`);
  }
  if (info.Driver !== 'overlay2') {
    throw new Error(`dockerd storage driver mismatch: expected overlay2, observed ${info.Driver ?? 'missing'}`);
  }
}

const NVIDIA_RUNTIME_BIN = '/usr/bin/nvidia-container-runtime';

/**
 * Path to a minimal daemon.json used exclusively by the nyabase-managed
 * dockerd.  We write an empty `{}` here so that dockerd does NOT read the
 * system-wide /etc/docker/daemon.json, which may contain directives
 * (data-root, exec-opts, …) that conflict with our CLI flags.
 */
const NYABASE_DAEMON_JSON_PATH = '/etc/nyabase/docker-daemon.json';

export class DaemonDockerProbeTimeoutError extends Error {
  constructor(
    public readonly operation: string,
    public readonly timeoutMs: number,
  ) {
    super(`Docker daemon probe timed out after ${timeoutMs}ms: ${operation}`);
    this.name = 'DaemonDockerProbeTimeoutError';
  }
}

export function withDaemonDockerDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(
      new DaemonDockerProbeTimeoutError(operation, timeoutMs),
    ), timeoutMs);
    timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export interface DockerSocketWaitOptions {
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  probeTimeoutMs?: number;
  description?: string;
}

/**
 * Poll dockerd with a deadline on every individual ping as well as the whole
 * startup wait. A never-settling ping therefore cannot defeat reconciliation.
 */
export async function waitForDockerSocket(
  ping: () => Promise<unknown>,
  options: DockerSocketWaitOptions = {},
): Promise<void> {
  const waitTimeoutMs = options.waitTimeoutMs ?? SOCKET_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? SOCKET_POLL_INTERVAL_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DAEMON_DOCKER_PROBE_TIMEOUT_MS;
  const description = options.description ?? 'dockerd socket';
  const deadline = Date.now() + waitTimeoutMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      await withDaemonDockerDeadline(
        ping(),
        Math.max(1, Math.min(probeTimeoutMs, remaining)),
        `ping ${description}`,
      );
      return;
    } catch {
      const pollRemaining = deadline - Date.now();
      if (pollRemaining <= 0) break;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(pollIntervalMs, pollRemaining));
      });
    }
  }
  throw new Error(`Timed out waiting ${waitTimeoutMs / 1000}s for ${description}`);
}

/** Atomically converge a trusted root-owned config file to exact bytes. */
export function ensureExactFileAtomic(filePath: string, expected: string, mode = 0o644): boolean {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic-link config path ${filePath}`);
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (fs.readFileSync(fd, 'utf8') === expected) return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let tempFd: number | null = null;
  try {
    tempFd = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY
      | fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | fs.constants.O_NOFOLLOW,
      mode,
    );
    fs.writeFileSync(tempFd, expected, 'utf8');
    fs.fchmodSync(tempFd, mode);
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = null;
    fs.renameSync(tempPath, filePath);
    const dirFd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
    return false;
  } catch (error) {
    if (tempFd !== null) fs.closeSync(tempFd);
    try { fs.unlinkSync(tempPath); } catch { /* best effort temp cleanup */ }
    throw error;
  }
}

function ensureNyabaseDaemonJson(): void {
  ensureExactFileAtomic(NYABASE_DAEMON_JSON_PATH, '{}\n');
}

export function renderDockerLimitSliceFile(plan: DockerResourceLimitPlan): string | null {
  if (!plan.enabled || plan.memory.maxBytes === null) return null;

  const cpuQuota = plan.cpu.quotaPercent === null ? '' : `CPUQuota=${plan.cpu.quotaPercent}%\n`;
  return `[Unit]
Description=nyabase Docker resource limit slice

[Slice]
${cpuQuota}MemoryHigh=${plan.memory.highBytes}
MemoryMax=${plan.memory.maxBytes}
`;
}

export function renderUnitFile(dockerRoot: string, gpuEnabled: boolean, plan: DockerResourceLimitPlan): string {
  const nvidiaFlag =
    gpuEnabled && fs.existsSync(NVIDIA_RUNTIME_BIN)
      ? `  --add-runtime nvidia=${NVIDIA_RUNTIME_BIN} \\\n`
      : '';
  const cgroupParentFlag = plan.cgroupParent === null
    ? ''
    : `  --cgroup-parent=${plan.cgroupParent} \\\n`;
  const sliceDirective = plan.enabled ? `Slice=${DOCKER_LIMIT_SLICE_NAME}\n` : '';

  return `[Unit]
Description=nyabase-managed Docker daemon
Documentation=https://docs.docker.com
After=network-online.target
Wants=network-online.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
Type=notify
${sliceDirective}Delegate=yes
ExecStart=/usr/bin/dockerd \\
  --config-file=${NYABASE_DAEMON_JSON_PATH} \\
  --pidfile=/run/nyabase-agent/docker.pid \\
  --data-root=${dockerRoot} \\
  --host=unix://${SOCKET_PATH} \\
${nvidiaFlag}${cgroupParentFlag}  --exec-opt native.cgroupdriver=systemd \\
  --storage-driver=overlay2 \\
  --log-driver=json-file \\
  --log-opt max-size=10m \\
  --log-opt max-file=3
ExecReload=/bin/kill -s HUP $MAINPID
TimeoutStartSec=0
RestartSec=5
Restart=always
KillMode=control-group
TimeoutStopSec=30s
SendSIGKILL=yes
OOMScoreAdjust=-500
RuntimeDirectory=nyabase-agent

[Install]
WantedBy=multi-user.target
`;
}

export class DaemonManager {
  private readonly dockerRoot: string;
  private readonly gpuEnabled: boolean;
  private readonly resourceLimitConfig: DockerResourceLimitConfig;
  private readonly dockerode: Dockerode;

  constructor(dockerRoot: string, gpuEnabled = false, resourceLimitConfig: DockerResourceLimitConfig = { enabled: false }) {
    this.dockerRoot = dockerRoot;
    this.gpuEnabled = gpuEnabled;
    this.resourceLimitConfig = resourceLimitConfig;
    // DaemonManager only issues unary probes, so a modem-level timeout can
    // safely destroy wedged HTTP requests (unlike long-lived exec/event APIs).
    this.dockerode = new Dockerode({
      socketPath: SOCKET_PATH,
      timeout: DAEMON_DOCKER_PROBE_TIMEOUT_MS,
    });
  }

  /**
   * Ensure the systemd unit file is in sync, the service is enabled, and the
   * docker daemon is running. Blocks until the socket is reachable or timeout.
   * Returns the live status after reconciliation.
   */
  async reconcile(serverId: string): Promise<DockerDaemonStatus> {
    this.assertSupportedOs();
    this.assertDockerdPresent();
    this.ensureDaemonConfig();

    const plan = this.getResourceLimitPlan();
    const inSync = this.syncSystemdUnits(plan);
    // Always reload. A previous Agent may have crashed after atomically
    // replacing the files but before systemd consumed them; on-disk equality
    // is not evidence about systemd's loaded unit state.
    await this.systemctl('daemon-reload');
    if (!inSync) {
      await this.systemctl('restart', UNIT_NAME);
    } else {
      await this.systemctl('start', UNIT_NAME);
    }

    await this.systemctl('enable', UNIT_NAME);

    // Wait for socket to become reachable
    await this.waitForSocket();
    await this.assertLiveDaemonIdentity();
    return this.getStatus(serverId);
  }

  /**
   * Pure status query — does not modify unit file or start the daemon.
   */
  async getStatus(serverId: string): Promise<DockerDaemonStatus> {
    const plan = this.getResourceLimitPlan();
    const unitFileInSync = this.areSystemdUnitsInSync(plan);

    const { activeState, unitFileState, mainPid } = await this.querySystemctl();
    const state = mapActiveState(activeState);
    const enabled = unitFileState === 'enabled' || unitFileState === 'enabled-runtime';
    const active = activeState === 'active';

    let serverVersion: string | null = null;
    let storageDriver: string | null = null;
    let liveDockerRoot: string | null = null;
    let lastError: string | null = null;

    if (active) {
      try {
        const [versionInfo, dockerInfo] = await withDaemonDockerDeadline(
          Promise.all([
            this.dockerode.version() as Promise<{ Version?: string }>,
            this.dockerode.info() as Promise<{ Driver?: string; DockerRootDir?: string }>,
          ]),
          DAEMON_DOCKER_PROBE_TIMEOUT_MS,
          'read dockerd version and info',
        );
        serverVersion = versionInfo.Version ?? null;
        storageDriver = dockerInfo.Driver ?? null;
        liveDockerRoot = dockerInfo.DockerRootDir ?? null;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    } else {
      // Try to pull last error from journald
      try {
        const { stdout } = await execFileAsync(
          'journalctl', ['-u', UNIT_NAME, '-n', '5', '--no-pager', '-o', 'short'],
          { timeout: 5000 },
        );
        lastError = stdout.trim() || null;
      } catch { /* best-effort */ }
    }

    const resourceLimit = {
      enabled: plan.enabled,
      cgroupParent: plan.cgroupParent,
      hostCpuCores: plan.cpu.hostCores,
      reservedCpuCores: plan.cpu.reservedCores,
      dockerCpuCores: plan.cpu.dockerCores,
      cpuQuotaPercent: plan.cpu.quotaPercent,
      hostMemBytes: plan.memory.totalBytes,
      reservedMemBytes: plan.memory.reservedBytes,
      memoryHighBytes: plan.memory.highBytes,
      memoryMaxBytes: plan.memory.maxBytes,
      sliceUnit: plan.enabled ? DOCKER_LIMIT_SLICE_NAME : null,
      sliceFileInSync: plan.enabled ? this.isLimitSliceFileInSync(plan) : true,
      unconfinedContainerCount: await this.countContainersOutsideCgroupParent(plan),
    };

    return {
      serverId,
      state,
      unitFileInSync,
      enabled,
      active,
      pid: mainPid ?? null,
      dockerRoot: liveDockerRoot ?? this.dockerRoot,
      socketPath: SOCKET_PATH,
      serverVersion,
      storageDriver,
      resourceLimit,
      lastError,
      checkedAt: Date.now(),
    };
  }

  getContainerCgroupParent(): string | null {
    return this.getResourceLimitPlan().cgroupParent;
  }

  private async assertLiveDaemonIdentity(): Promise<void> {
    const info = await withDaemonDockerDeadline(
      this.dockerode.info() as Promise<{ Driver?: string; DockerRootDir?: string }>,
      DAEMON_DOCKER_PROBE_TIMEOUT_MS,
      'verify dockerd physical identity',
    );
    assertDockerDaemonIdentity(this.dockerRoot, info);
  }

  private getResourceLimitPlan(): DockerResourceLimitPlan {
    return calculateDockerResourceLimitPlan(this.resourceLimitConfig, getHostResourceSnapshot());
  }

  private assertSupportedOs(): void {
    let osRelease: string;
    try {
      osRelease = fs.readFileSync('/etc/os-release', 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Cannot detect OS: /etc/os-release not found. Only Ubuntu and Debian are supported.');
      }
      throw err;
    }

    const extract = (key: string) =>
      (osRelease.match(new RegExp(`^${key}=(.+)`, 'm'))?.[1] ?? '')
        .replace(/^"|"$/g, '')
        .toLowerCase();

    const id = extract('ID');
    const idLike = extract('ID_LIKE');
    const combined = `${id} ${idLike}`;

    if (!combined.includes('ubuntu') && !combined.includes('debian')) {
      throw new Error(
        `Unsupported OS: only Ubuntu and Debian are supported. Got ID="${id}" ID_LIKE="${idLike}".`,
      );
    }
  }

  private assertDockerdPresent(): void {
    if (!fs.existsSync('/usr/bin/dockerd') && !fs.existsSync('/usr/local/bin/dockerd')) {
      throw new Error(
        'dockerd binary not found at /usr/bin/dockerd or /usr/local/bin/dockerd. ' +
        'Please install docker-ce before starting the agent.',
      );
    }
  }

  private syncSystemdUnits(plan: DockerResourceLimitPlan): boolean {
    const serviceInSync = this.syncUnitFile(
      UNIT_PATH,
      renderUnitFile(this.dockerRoot, this.gpuEnabled, plan),
    );
    const sliceContent = renderDockerLimitSliceFile(plan);
    const sliceInSync = sliceContent === null
      ? this.removeUnitFileIfExists(DOCKER_LIMIT_SLICE_PATH)
      : this.syncUnitFile(DOCKER_LIMIT_SLICE_PATH, sliceContent);
    return serviceInSync && sliceInSync;
  }

  private areSystemdUnitsInSync(plan: DockerResourceLimitPlan): boolean {
    const serviceInSync = this.isUnitFileInSync(
      UNIT_PATH,
      renderUnitFile(this.dockerRoot, this.gpuEnabled, plan),
    );
    return serviceInSync && (!plan.enabled || this.isLimitSliceFileInSync(plan));
  }

  private isLimitSliceFileInSync(plan: DockerResourceLimitPlan): boolean {
    const sliceContent = renderDockerLimitSliceFile(plan);
    return sliceContent === null
      ? !fs.existsSync(DOCKER_LIMIT_SLICE_PATH)
      : this.isUnitFileInSync(DOCKER_LIMIT_SLICE_PATH, sliceContent);
  }

  /**
   * Writes a unit file if it differs from the current on-disk content.
   * @returns true if file was already in sync (no write needed), false if it was updated.
   */
  private syncUnitFile(unitPath: string, expected: string): boolean {
    const inSync = ensureExactFileAtomic(unitPath, expected);
    if (!inSync) console.log('[DaemonManager] Wrote unit file:', unitPath);
    return inSync;
  }

  private ensureDaemonConfig(): void {
    ensureNyabaseDaemonJson();
  }

  private removeUnitFileIfExists(unitPath: string): boolean {
    if (!fs.existsSync(unitPath)) return true;
    console.log('[DaemonManager] Removing unit file:', unitPath);
    fs.unlinkSync(unitPath);
    return false;
  }

  private isUnitFileInSync(unitPath: string, expected: string): boolean {
    try {
      const current = fs.readFileSync(unitPath, 'utf-8');
      return current === expected;
    } catch {
      return false;
    }
  }

  private async countContainersOutsideCgroupParent(plan: DockerResourceLimitPlan): Promise<number | null> {
    if (!plan.enabled || plan.cgroupParent === null) return null;
    const deadline = Date.now() + DAEMON_DOCKER_PROBE_TIMEOUT_MS;
    const probe = <T>(promise: Promise<T>, operation: string): Promise<T> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return Promise.reject(new DaemonDockerProbeTimeoutError(operation, 0));
      }
      return withDaemonDockerDeadline(promise, remaining, operation);
    };
    try {
      const containers = await probe(
        this.dockerode.listContainers({
          all: true,
          filters: { label: [`${LABEL.MANAGED}=true`] },
        }),
        'list managed containers for cgroup audit',
      );
      let count = 0;
      for (const container of containers) {
        const info = await probe(
          this.dockerode.getContainer(container.Id).inspect(),
          `inspect managed container ${container.Id} for cgroup audit`,
        );
        const cgroupParent = info.HostConfig?.CgroupParent ?? '';
        if (cgroupParent !== plan.cgroupParent) count += 1;
      }
      return count;
    } catch {
      return null;
    }
  }

  /** Whether the nvidia-container-runtime is available on this host. */
  isNvidiaRuntimeAvailable(): boolean {
    return this.gpuEnabled && fs.existsSync(NVIDIA_RUNTIME_BIN);
  }

  private async systemctl(...args: string[]): Promise<void> {
    try {
      // systemctl may outlive its caller while systemd is still completing a
      // daemon start/restart. Keep the cross-restart physical flock in the
      // helper so the next Agent must quiesce that effect before proceeding.
      await runIsolatedCommand('/usr/bin/systemctl', args, 30_000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Enabling persistence is best effort for an already running Agent.
      // daemon-reload is part of physical identity convergence and must fail
      // closed; otherwise an old loaded unit can masquerade as the exact file.
      if (args[0] === 'enable') {
        console.warn(`[DaemonManager] systemctl ${args.join(' ')} warning:`, msg);
        return;
      }
      throw err;
    }
  }

  private async querySystemctl(): Promise<{
    activeState: string;
    unitFileState: string;
    mainPid: number | null;
  }> {
    try {
      const { stdout } = await execFileAsync(
        'systemctl', ['show', UNIT_NAME, '--property=ActiveState,UnitFileState,MainPID'],
        { timeout: 10_000 },
      );
      const props: Record<string, string> = {};
      for (const line of stdout.trim().split('\n')) {
        const idx = line.indexOf('=');
        if (idx > 0) props[line.slice(0, idx)] = line.slice(idx + 1);
      }
      const mainPidRaw = parseInt(props['MainPID'] ?? '0', 10);
      return {
        activeState: props['ActiveState'] ?? 'unknown',
        unitFileState: props['UnitFileState'] ?? 'unknown',
        mainPid: mainPidRaw > 0 ? mainPidRaw : null,
      };
    } catch {
      return { activeState: 'unknown', unitFileState: 'unknown', mainPid: null };
    }
  }

  private async waitForSocket(): Promise<void> {
    return waitForDockerSocket(
      () => this.dockerode.ping(),
      { description: `dockerd socket at ${SOCKET_PATH}` },
    );
  }
}

function mapActiveState(state: string): DockerDaemonState {
  switch (state) {
    case 'active': return DockerDaemonState.Active;
    case 'activating': return DockerDaemonState.Activating;
    case 'inactive': return DockerDaemonState.Inactive;
    case 'failed': return DockerDaemonState.Failed;
    default: return DockerDaemonState.Unknown;
  }
}
