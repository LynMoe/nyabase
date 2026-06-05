import * as crypto from 'crypto';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  ContainerSshServerState,
  ContainerStatus,
  ReconcileContainerSshPayload,
  SelfCheckItem,
} from '@nyabase/common';
import { DockerClient } from '../docker/docker-client.js';
import { DropbearAsset, resolveAndExtractDropbear } from './dropbear-embed.js';

const execFileAsync = promisify(execFile);

const CONTAINER_BINARY = '/usr/local/bin/nyabase-dropbear';
const CONTAINER_BINARY_HASH = '/usr/local/bin/nyabase-dropbear.sha256';
const ROOT_SSH_DIR = '/root/.ssh';
const AUTHORIZED_KEYS = '/root/.ssh/authorized_keys';
const PID_FILE = '/run/nyabase-dropbear.pid';
const DROPBEAR_DIR = '/etc/dropbear';

type RunExclusive = <T>(dockerId: string, fn: () => Promise<T>) => Promise<T>;

export interface DropbearReconcileResult extends ContainerSshServerState {
  binaryUpdated: boolean;
  keysUpdated: boolean;
  restarted: boolean;
}

export class DropbearManager {
  private supportsA: boolean | null = null;
  private readonly lastReconciled = new Map<string, { at: number; keyHash: string; error?: string }>();

  constructor(
    private docker: DockerClient,
    private runExclusive: RunExclusive,
    private asset: DropbearAsset = resolveAndExtractDropbear(),
  ) {}

  async reconcileContainerSsh(payload: ReconcileContainerSshPayload): Promise<DropbearReconcileResult> {
    return this.runExclusive(payload.runtimeId, () => this.reconcileUnlocked(payload));
  }

  async inspectContainerSshState(
    dockerId: string,
    labelEnabled: boolean,
    status: ContainerStatus,
  ): Promise<ContainerSshServerState> {
    if (status !== ContainerStatus.Running) {
      const last = this.lastReconciled.get(dockerId);
      return labelEnabled || last
        ? { enabled: true, status: 'container_stopped', user: 'root', port: 22, keyHash: last?.keyHash, lastReconciledAt: last?.at, lastError: last?.error }
        : { enabled: false, status: 'disabled', user: 'root', port: 22 };
    }

    try {
      const pid = await this.readRunningPid(dockerId);
      const keyHash = await this.readAuthorizedKeysHash(dockerId);
      const last = this.lastReconciled.get(dockerId);
      const enabled = labelEnabled || !!pid || !!keyHash || !!last;
      if (!enabled) {
        return { enabled: false, status: 'disabled', user: 'root', port: 22 };
      }
      if (pid) {
        return {
          enabled: true,
          status: 'running',
          user: 'root',
          port: 22,
          pid,
          keyHash: keyHash ?? last?.keyHash,
          lastReconciledAt: last?.at,
          lastError: last?.error,
        };
      }
      return {
        enabled: true,
        status: 'unknown',
        user: 'root',
        port: 22,
        keyHash: keyHash ?? last?.keyHash,
        lastReconciledAt: last?.at,
        lastError: last?.error,
      };
    } catch (e) {
      const last = this.lastReconciled.get(dockerId);
      const message = this.errorMessage(e);
      if (!labelEnabled && !last) {
        return { enabled: false, status: 'disabled', user: 'root', port: 22 };
      }
      return {
        enabled: true,
        status: 'error',
        user: 'root',
        port: 22,
        keyHash: last?.keyHash,
        lastReconciledAt: last?.at,
        lastError: message,
      };
    }
  }

  async getSelfCheckItems(): Promise<SelfCheckItem[]> {
    const binaryItem = await this.checkBinary();
    if (binaryItem.status === 'fail') return [binaryItem];
    const optionsItem = await this.checkOptions();
    return [binaryItem, optionsItem];
  }

  private async reconcileUnlocked(payload: ReconcileContainerSshPayload): Promise<DropbearReconcileResult> {
    this.assertDropbearAssetAvailable();

    const inspect = await this.docker.inspectContainer(payload.runtimeId);
    if (inspect.State.Status !== 'running') {
      throw new Error(`Container ${payload.runtimeId} is not running`);
    }

    const normalizedKeys = this.normalizeKeys(payload.publicKeys);
    const keyHash = this.sha256(Buffer.from(normalizedKeys));
    if (payload.expectedKeyHash && payload.expectedKeyHash !== keyHash) {
      throw new Error('SSH key hash mismatch');
    }

    try {
      const previousKeyHash = await this.readAuthorizedKeysHash(payload.runtimeId);
      await this.ensureRootSshFiles(payload.runtimeId, normalizedKeys);
      const binaryUpdated = await this.ensureBinary(payload.runtimeId);
      await this.execShell(payload.runtimeId, `mkdir -p ${this.q(DROPBEAR_DIR)} /run && chown root:root ${this.q(DROPBEAR_DIR)} && chmod 700 ${this.q(DROPBEAR_DIR)}`);

      let pid = await this.readRunningPid(payload.runtimeId);
      let restarted = false;
      if (pid && binaryUpdated) {
        await this.execShell(payload.runtimeId, `kill ${pid} || true`);
        pid = null;
        restarted = true;
      }

      if (!pid) {
        await this.startDropbear(payload.runtimeId);
        pid = await this.readRunningPid(payload.runtimeId);
      }
      if (!pid) {
        throw new Error('Dropbear did not create a running pid file');
      }

      const at = Date.now();
      this.lastReconciled.set(payload.runtimeId, { at, keyHash });
      return {
        enabled: true,
        status: 'running',
        user: 'root',
        port: 22,
        pid,
        keyHash,
        lastReconciledAt: at,
        binaryUpdated,
        keysUpdated: previousKeyHash !== keyHash,
        restarted,
      };
    } catch (e) {
      const at = Date.now();
      this.lastReconciled.set(payload.runtimeId, { at, keyHash, error: this.errorMessage(e) });
      throw e;
    }
  }

  private async ensureRootSshFiles(dockerId: string, authorizedKeys: string): Promise<void> {
    await this.execShell(dockerId, `mkdir -p ${this.q(ROOT_SSH_DIR)} && chown root:root /root ${this.q(ROOT_SSH_DIR)} && chmod 700 ${this.q(ROOT_SSH_DIR)}`);
    const tmp = `${AUTHORIZED_KEYS}.tmp`;
    await this.docker.putFile(dockerId, tmp, Buffer.from(authorizedKeys, 'utf-8'), 0o600);
    await this.execShell(dockerId, `chmod 600 ${this.q(tmp)} && chown root:root ${this.q(tmp)} && mv -f ${this.q(tmp)} ${this.q(AUTHORIZED_KEYS)}`);
  }

  private async ensureBinary(dockerId: string): Promise<boolean> {
    const binary = fs.readFileSync(this.asset.binaryPath);
    const hash = this.sha256(binary);
    const existing = await this.readTextFile(dockerId, CONTAINER_BINARY_HASH);
    if (existing?.trim() === hash) return false;

    await this.execShell(dockerId, 'mkdir -p /usr/local/bin');
    const tmp = `${CONTAINER_BINARY}.tmp`;
    await this.docker.putFile(dockerId, tmp, binary, 0o755);
    await this.execShell(
      dockerId,
      [
        `chmod 755 ${this.q(tmp)}`,
        `chown root:root ${this.q(tmp)}`,
        `mv -f ${this.q(tmp)} ${this.q(CONTAINER_BINARY)}`,
        `printf %s ${this.q(hash)} > ${this.q(CONTAINER_BINARY_HASH)}`,
        `chmod 644 ${this.q(CONTAINER_BINARY_HASH)}`,
        `chown root:root ${this.q(CONTAINER_BINARY_HASH)}`,
      ].join(' && '),
    );
    return true;
  }

  private async startDropbear(dockerId: string): Promise<void> {
    const supportsA = await this.binarySupportsA();
    const args = [
      '-R',
      '-s',
      '-p',
      '0.0.0.0:22',
      '-P',
      PID_FILE,
      ...(supportsA ? ['-a'] : []),
    ];
    await this.execShell(dockerId, `${this.q(CONTAINER_BINARY)} ${args.map((a) => this.q(a)).join(' ')}`);
  }

  private async readRunningPid(dockerId: string): Promise<number | null> {
    const result = await this.docker.execCapture(dockerId, [
      '/bin/sh',
      '-c',
      `pid="$(cat ${this.q(PID_FILE)} 2>/dev/null || true)"; case "$pid" in ''|*[!0-9]*) exit 1;; esac; kill -0 "$pid" 2>/dev/null && printf %s "$pid"`,
    ]);
    if (result.exitCode !== 0) return null;
    const pid = parseInt(result.stdout.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  }

  private async readAuthorizedKeysHash(dockerId: string): Promise<string | undefined> {
    const result = await this.docker.execCapture(dockerId, [
      '/bin/sh',
      '-c',
      `test -f ${this.q(AUTHORIZED_KEYS)} && sha256sum ${this.q(AUTHORIZED_KEYS)} | awk '{print $1}'`,
    ]);
    if (result.exitCode !== 0) return undefined;
    const hash = result.stdout.trim();
    return hash || undefined;
  }

  private async readTextFile(dockerId: string, filePath: string): Promise<string | null> {
    const result = await this.docker.execCapture(dockerId, ['/bin/sh', '-c', `cat ${this.q(filePath)} 2>/dev/null`]);
    if (result.exitCode !== 0) return null;
    return result.stdout;
  }

  private async execShell(dockerId: string, script: string): Promise<string> {
    const result = await this.docker.execCapture(dockerId, ['/bin/sh', '-c', script], 30_000);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `shell exited ${result.exitCode}`);
    }
    return result.stdout;
  }

  private normalizeKeys(publicKeys: string[]): string {
    return publicKeys.map((k) => k.trim()).filter(Boolean).join('\n') + '\n';
  }

  private async checkBinary(): Promise<SelfCheckItem> {
    if (this.asset.source === 'missing') {
      return {
        id: 'dropbear_binary',
        label: 'Dropbear binary',
        status: 'fail',
        message: this.asset.missingReason ?? 'Dropbear binary is not configured',
      };
    }

    try {
      const binary = fs.readFileSync(this.asset.binaryPath);
      const hash = this.sha256(binary);
      const stat = fs.statSync(this.asset.binaryPath);
      if ((stat.mode & 0o111) === 0) {
        return { id: 'dropbear_binary', label: 'Dropbear binary', status: 'fail', message: `${this.asset.binaryPath} is not executable` };
      }
      const expected = this.readExpectedSha256();
      if (expected && expected !== hash) {
        return { id: 'dropbear_binary', label: 'Dropbear binary', status: 'fail', message: `sha256 mismatch for ${this.asset.binaryPath}` };
      }
      await this.runDropbearHelp();
      return {
        id: 'dropbear_binary',
        label: 'Dropbear binary',
        status: expected ? 'ok' : 'warn',
        message: expected
          ? `Dropbear asset OK (${this.asset.source}, sha256 ${hash.slice(0, 12)})`
          : `Dropbear asset executable but no sha256 sidecar found (${this.asset.source})`,
      };
    } catch (e) {
      return { id: 'dropbear_binary', label: 'Dropbear binary', status: 'fail', message: this.errorMessage(e) };
    }
  }

  private async checkOptions(): Promise<SelfCheckItem> {
    try {
      const supportsA = await this.binarySupportsA();
      return {
        id: 'dropbear_options',
        label: 'Dropbear options',
        status: supportsA ? 'ok' : 'warn',
        message: supportsA
          ? 'Dropbear supports -a for remote forwarded port exposure'
          : 'Dropbear help did not advertise -a; SSH will run without that option',
      };
    } catch (e) {
      return { id: 'dropbear_options', label: 'Dropbear options', status: 'fail', message: this.errorMessage(e) };
    }
  }

  private async binarySupportsA(): Promise<boolean> {
    if (this.supportsA !== null) return this.supportsA;
    const help = await this.runDropbearHelp();
    this.supportsA = /(^|[^A-Za-z0-9_])-a([^A-Za-z0-9_]|$)/.test(help);
    return this.supportsA;
  }

  private async runDropbearHelp(): Promise<string> {
    this.assertDropbearAssetAvailable();
    try {
      const { stdout, stderr } = await execFileAsync(this.asset.binaryPath, ['-h'], { timeout: 3000 });
      return `${stdout}${stderr}`;
    } catch (e) {
      const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
      const output = `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`;
      if (output) return output;
      throw new Error(err.message ?? String(e));
    }
  }

  private readExpectedSha256(): string | null {
    if (!this.asset.sha256Path || !fs.existsSync(this.asset.sha256Path)) return null;
    const raw = fs.readFileSync(this.asset.sha256Path, 'utf-8').trim();
    return raw.split(/\s+/)[0] || null;
  }

  private assertDropbearAssetAvailable(): void {
    if (this.asset.source === 'missing') {
      throw new Error(this.asset.missingReason ?? 'Dropbear binary is not configured');
    }
    if (!this.asset.binaryPath || !fs.existsSync(this.asset.binaryPath)) {
      throw new Error(`Dropbear binary not found: ${this.asset.binaryPath || '(not configured)'}`);
    }
  }

  private sha256(data: Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  private q(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
