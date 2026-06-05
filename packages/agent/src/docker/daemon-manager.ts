import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Dockerode from 'dockerode';
import { DockerDaemonState, type DockerDaemonStatus } from '@nyabase/common';

const execFileAsync = promisify(execFile);

export const SOCKET_PATH = '/run/nyabase-agent/docker.sock';
const UNIT_NAME = 'nyabase-docker.service';
const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}`;

/** Maximum wait time for dockerd socket to become reachable after start (ms) */
const SOCKET_WAIT_TIMEOUT_MS = 60_000;
const SOCKET_POLL_INTERVAL_MS = 500;

const NVIDIA_RUNTIME_BIN = '/usr/bin/nvidia-container-runtime';

/**
 * Path to a minimal daemon.json used exclusively by the nyabase-managed
 * dockerd.  We write an empty `{}` here so that dockerd does NOT read the
 * system-wide /etc/docker/daemon.json, which may contain directives
 * (data-root, exec-opts, …) that conflict with our CLI flags.
 */
const NYABASE_DAEMON_JSON_PATH = '/etc/nyabase/docker-daemon.json';

function ensureNyabaseDaemonJson(): void {
  try {
    const dir = '/etc/nyabase';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    if (!fs.existsSync(NYABASE_DAEMON_JSON_PATH)) {
      fs.writeFileSync(NYABASE_DAEMON_JSON_PATH, '{}\n', { mode: 0o644 });
    }
  } catch (e) {
    console.warn('[DaemonManager] Could not write docker-daemon.json:', e);
  }
}

function renderUnitFile(dockerRoot: string, gpuEnabled: boolean): string {
  const nvidiaFlag =
    gpuEnabled && fs.existsSync(NVIDIA_RUNTIME_BIN)
      ? `  --add-runtime nvidia=${NVIDIA_RUNTIME_BIN} \\\n`
      : '';

  return `[Unit]
Description=nyabase-managed Docker daemon
Documentation=https://docs.docker.com
After=network-online.target
Wants=network-online.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
Type=notify
ExecStart=/usr/bin/dockerd \\
  --config-file=${NYABASE_DAEMON_JSON_PATH} \\
  --pidfile=/run/nyabase-agent/docker.pid \\
  --data-root=${dockerRoot} \\
  --host=unix://${SOCKET_PATH} \\
${nvidiaFlag}  --exec-opt native.cgroupdriver=systemd \\
  --storage-driver=overlay2 \\
  --log-driver=json-file \\
  --log-opt max-size=10m \\
  --log-opt max-file=3
ExecReload=/bin/kill -s HUP $MAINPID
TimeoutStartSec=0
RestartSec=5
Restart=always
KillMode=process
OOMScoreAdjust=-500
RuntimeDirectory=nyabase-agent

[Install]
WantedBy=multi-user.target
`;
}

export class DaemonManager {
  private readonly dockerRoot: string;
  private readonly gpuEnabled: boolean;
  private readonly dockerode: Dockerode;

  constructor(dockerRoot: string, gpuEnabled = false) {
    this.dockerRoot = dockerRoot;
    this.gpuEnabled = gpuEnabled;
    this.dockerode = new Dockerode({ socketPath: SOCKET_PATH });
  }

  /**
   * Ensure the systemd unit file is in sync, the service is enabled, and the
   * docker daemon is running. Blocks until the socket is reachable or timeout.
   * Returns the live status after reconciliation.
   */
  async reconcile(serverId: string): Promise<DockerDaemonStatus> {
    this.assertSupportedOs();
    this.assertDockerdPresent();
    ensureNyabaseDaemonJson();

    const expected = renderUnitFile(this.dockerRoot, this.gpuEnabled);
    const inSync = this.syncUnitFile(expected);
    if (!inSync) {
      await this.systemctl('daemon-reload');
    }

    // Enable + start (idempotent)
    await this.systemctl('enable', UNIT_NAME);
    await this.systemctl('start', UNIT_NAME);

    // Wait for socket to become reachable
    await this.waitForSocket();

    return this.getStatus(serverId);
  }

  /**
   * Pure status query — does not modify unit file or start the daemon.
   */
  async getStatus(serverId: string): Promise<DockerDaemonStatus> {
    const expected = renderUnitFile(this.dockerRoot, this.gpuEnabled);
    const unitFileInSync = this.isUnitFileInSync(expected);

    const { activeState, unitFileState, mainPid } = await this.querySystemctl();
    const state = mapActiveState(activeState);
    const enabled = unitFileState === 'enabled' || unitFileState === 'enabled-runtime';
    const active = activeState === 'active';

    let serverVersion: string | null = null;
    let storageDriver: string | null = null;
    let lastError: string | null = null;

    if (active) {
      try {
        const info = await this.dockerode.version() as { Version?: string };
        serverVersion = info.Version ?? null;
        const dockerInfo = await this.dockerode.info() as { Driver?: string };
        storageDriver = dockerInfo.Driver ?? null;
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

    return {
      serverId,
      state,
      unitFileInSync,
      enabled,
      active,
      pid: mainPid ?? null,
      dockerRoot: this.dockerRoot,
      socketPath: SOCKET_PATH,
      serverVersion,
      storageDriver,
      lastError,
      checkedAt: Date.now(),
    };
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

  /**
   * Writes the unit file if it differs from the current on-disk content.
   * @returns true if file was already in sync (no write needed), false if it was updated.
   */
  private syncUnitFile(expected: string): boolean {
    try {
      const current = fs.readFileSync(UNIT_PATH, 'utf-8');
      if (current === expected) return true;
    } catch {
      // file does not exist — fall through to write
    }
    console.log('[DaemonManager] Writing unit file:', UNIT_PATH);
    fs.writeFileSync(UNIT_PATH, expected, { mode: 0o644 });
    return false;
  }

  private isUnitFileInSync(expected: string): boolean {
    try {
      const current = fs.readFileSync(UNIT_PATH, 'utf-8');
      return current === expected;
    } catch {
      return false;
    }
  }

  /** Whether the nvidia-container-runtime is available on this host. */
  isNvidiaRuntimeAvailable(): boolean {
    return this.gpuEnabled && fs.existsSync(NVIDIA_RUNTIME_BIN);
  }

  private async systemctl(...args: string[]): Promise<void> {
    try {
      await execFileAsync('systemctl', args, { timeout: 30_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // daemon-reload and enable failures are logged as warnings; start failures are propagated.
      if (args[0] === 'daemon-reload' || args[0] === 'enable') {
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
    const deadline = Date.now() + SOCKET_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await this.dockerode.ping();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, SOCKET_POLL_INTERVAL_MS));
      }
    }
    throw new Error(
      `Timed out waiting ${SOCKET_WAIT_TIMEOUT_MS / 1000}s for dockerd socket at ${SOCKET_PATH}`,
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
