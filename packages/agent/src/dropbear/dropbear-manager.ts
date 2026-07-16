import * as crypto from 'crypto';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  ContainerSshServerState,
  ContainerStatus,
  SelfCheckItem,
} from '@nyabase/common';
import { DockerClient } from '../docker/docker-client.js';
import { DropbearAsset, resolveAndExtractDropbear } from './dropbear-embed.js';

const execFileAsync = promisify(execFile);

const CONTAINER_BINARY = '/usr/local/bin/nyabase-dropbear';
const CONTAINER_BINARY_HASH = '/usr/local/bin/nyabase-dropbear.sha256';
const CONTAINER_DROPBEARKEY = '/usr/local/bin/nyabase-dropbearkey';
const CONTAINER_DROPBEARKEY_HASH = '/usr/local/bin/nyabase-dropbearkey.sha256';
const CONTAINER_SFTP_SERVER = '/usr/libexec/sftp-server';
const CONTAINER_SFTP_SERVER_HASH = '/usr/libexec/sftp-server.sha256';
const ROOT_SSH_DIR = '/root/.ssh';
const AUTHORIZED_KEYS = '/root/.ssh/authorized_keys';
const PID_FILE = '/run/nyabase-dropbear.pid';
const DROPBEAR_DIR = '/etc/dropbear';
const KEY_GENERATION_FILE = '/run/nyabase-dropbear.key-generation';
const ED25519_HOST_KEY = `${DROPBEAR_DIR}/dropbear_ed25519_host_key`;

type RunExclusive = <T>(dockerId: string, fn: () => Promise<T>) => Promise<T>;

export interface DropbearReconcileInput {
  runtimeId: string;
  enabled: boolean;
  internalPublicKey?: string;
  internalKeyGeneration?: number;
  expectedKeyHash?: string;
}

export interface DropbearReconcileResult extends ContainerSshServerState {
  binaryUpdated: boolean;
  keysUpdated: boolean;
  restarted: boolean;
}

interface RunningProcessIdentity {
  pid: number;
  startTime: string;
}

interface SshRuntimeObservation {
  processIdentity: RunningProcessIdentity | null;
  keyHash?: string;
  generation?: number;
  hostKeyFingerprint?: string;
}

const SSH_INSPECT_TIMEOUT_MS = 5_000;
const SSH_STATE_HEADER = 'NYABASE_SSH_STATE_V1';
const SSH_HOST_KEY_BEGIN = 'NYABASE_SSH_HOST_KEY_BEGIN';
const SSH_HOST_KEY_END = 'NYABASE_SSH_HOST_KEY_END';

function expectedDropbearArgv(includeRemoteForwardExposure: boolean): string {
  return [
    CONTAINER_BINARY,
    '-s',
    '-r',
    ED25519_HOST_KEY,
    '-p',
    '0.0.0.0:22',
    '-P',
    PID_FILE,
    ...(includeRemoteForwardExposure ? ['-a'] : []),
  ].join('\n');
}

/** Convert the public-key wire blob emitted by `dropbearkey -y` to OpenSSH's SHA256 form. */
export function sshSha256FingerprintFromDropbearOutput(output: string): string | undefined {
  for (const rawLine of output.split(/\r?\n/)) {
    const match = /^(ssh-[A-Za-z0-9@._+-]+|ecdsa-[A-Za-z0-9@._+-]+)\s+([A-Za-z0-9+/]+={0,2})(?:\s|$)/.exec(rawLine.trim());
    if (!match) continue;
    const encoded = match[2];
    const wire = Buffer.from(encoded, 'base64');
    if (wire.length < 8 || wire.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
      return undefined;
    }
    const typeLength = wire.readUInt32BE(0);
    if (typeLength < 1 || typeLength > wire.length - 4) return undefined;
    if (wire.subarray(4, 4 + typeLength).toString('utf8') !== match[1]) return undefined;
    return `SHA256:${crypto.createHash('sha256').update(wire).digest('base64').replace(/=+$/, '')}`;
  }
  return undefined;
}

export class DropbearManager {
  private supportsA: boolean | null = null;

  constructor(
    private docker: DockerClient,
    private runExclusive: RunExclusive,
    private asset: DropbearAsset = resolveAndExtractDropbear(),
  ) {}

  async reconcileContainerSsh(payload: DropbearReconcileInput): Promise<DropbearReconcileResult> {
    return this.runExclusive(payload.runtimeId, () => this.reconcileUnlocked(payload));
  }

  async inspectContainerSshState(
    dockerId: string,
    status: ContainerStatus,
  ): Promise<ContainerSshServerState> {
    if (status !== ContainerStatus.Running) {
      return { enabled: false, status: 'container_stopped', user: 'root', port: 22 };
    }

    try {
      const {
        processIdentity,
        keyHash,
        generation,
        hostKeyFingerprint,
      } = await this.inspectSshRuntime(dockerId);
      const enabled = !!processIdentity || !!keyHash || generation !== undefined;
      if (!enabled) {
        return { enabled: false, status: 'disabled', user: 'root', port: 22 };
      }
      if (processIdentity) {
        return {
          enabled: true,
          status: 'running',
          user: 'root',
          port: 22,
          pid: processIdentity.pid,
          keyHash: keyHash ?? undefined,
          appliedKeyGeneration: generation,
          hostKeyFingerprint,
        };
      }
      return {
        enabled: true,
        status: 'unknown',
        user: 'root',
        port: 22,
        keyHash: keyHash ?? undefined,
        appliedKeyGeneration: generation,
        hostKeyFingerprint,
      };
    } catch (e) {
      const message = this.errorMessage(e);
      return {
        enabled: false,
        status: 'error',
        user: 'root',
        port: 22,
        lastError: message,
      };
    }
  }

  /** One bounded root exec per container keeps full-state reporting within a known budget. */
  private async inspectSshRuntime(dockerId: string): Promise<SshRuntimeObservation> {
    const result = await this.docker.execObservationCapture(
      dockerId,
      [
        '/bin/sh',
        '-c',
        [
          `process='-'`,
          `pid="$(cat ${this.q(PID_FILE)} 2>/dev/null || true)"`,
          `if [ -n "$pid" ]; then`,
          `  case "$pid" in *[!0-9]*) exit 42;; esac`,
          `  [ "$pid" -gt 1 ] || exit 42`,
          `  kill -0 "$pid" 2>/dev/null || pid=''`,
          `fi`,
          `if [ -n "$pid" ]; then`,
          `  exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"`,
          `  [ "$exe" = ${this.q(CONTAINER_BINARY)} ] || exit 42`,
          `  ${this.processArgvIdentityShell()}`,
          `  started="$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null)"`,
          `  case "$started" in ''|*[!0-9]*) exit 42;; esac`,
          `  process="$pid:$started"`,
          `fi`,
          `key_hash="$(test -f ${this.q(AUTHORIZED_KEYS)} && sha256sum ${this.q(AUTHORIZED_KEYS)} 2>/dev/null | awk '{print $1}' || true)"`,
          `generation="$(cat ${this.q(KEY_GENERATION_FILE)} 2>/dev/null || true)"`,
          `case "$generation" in ''|*[!0-9]*) generation='-';; esac`,
          `printf '%s\\nprocess=%s\\nkeyHash=%s\\ngeneration=%s\\n' ${this.q(SSH_STATE_HEADER)} "$process" "${'$'}{key_hash:--}" "$generation"`,
          `if [ -s ${this.q(ED25519_HOST_KEY)} ] && [ -x ${this.q(CONTAINER_DROPBEARKEY)} ]; then`,
          `  printf '%s\\n' ${this.q(SSH_HOST_KEY_BEGIN)}`,
          `  ${this.q(CONTAINER_DROPBEARKEY)} -y -f ${this.q(ED25519_HOST_KEY)} || exit 43`,
          `  printf '%s\\n' ${this.q(SSH_HOST_KEY_END)}`,
          `fi`,
        ].join('\n'),
      ],
      SSH_INSPECT_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim()
        || result.stdout.trim()
        || `SSH runtime inspection exited ${result.exitCode}`,
      );
    }
    return this.parseSshRuntimeObservation(result.stdout);
  }

  private parseSshRuntimeObservation(output: string): SshRuntimeObservation {
    const lines = output.split(/\r?\n/);
    if (lines.shift() !== SSH_STATE_HEADER) throw new Error('SSH runtime inspection output is invalid');
    const values = new Map<string, string>();
    let hostKeyOutput = '';
    let inHostKey = false;
    let sawHostKeyEnd = false;
    for (const line of lines) {
      if (line === SSH_HOST_KEY_BEGIN) {
        if (inHostKey || sawHostKeyEnd) throw new Error('SSH host-key inspection output is invalid');
        inHostKey = true;
        continue;
      }
      if (line === SSH_HOST_KEY_END) {
        if (!inHostKey) throw new Error('SSH host-key inspection output is invalid');
        inHostKey = false;
        sawHostKeyEnd = true;
        continue;
      }
      if (inHostKey) {
        hostKeyOutput += `${line}\n`;
        continue;
      }
      if (line === '') continue;
      const separator = line.indexOf('=');
      if (separator < 1) throw new Error('SSH runtime inspection output is invalid');
      const key = line.slice(0, separator);
      if (values.has(key)) throw new Error('SSH runtime inspection output contains duplicate fields');
      values.set(key, line.slice(separator + 1));
    }
    if (inHostKey) throw new Error('SSH host-key inspection output is incomplete');

    const processValue = values.get('process');
    const keyHashValue = values.get('keyHash');
    const generationValue = values.get('generation');
    if (processValue === undefined || keyHashValue === undefined || generationValue === undefined) {
      throw new Error('SSH runtime inspection output is incomplete');
    }
    let processIdentity: RunningProcessIdentity | null = null;
    if (processValue !== '-') {
      const match = /^(\d+):(\d+)$/.exec(processValue);
      const pid = Number(match?.[1]);
      if (!match || !Number.isSafeInteger(pid) || pid <= 1) {
        throw new Error('SSH runtime process identity is invalid');
      }
      processIdentity = { pid, startTime: match[2] };
    }
    const keyHash = keyHashValue === '-'
      ? undefined
      : (/^[a-f0-9]{64}$/i.test(keyHashValue) ? keyHashValue.toLowerCase() : undefined);
    if (keyHashValue !== '-' && !keyHash) throw new Error('SSH authorized-keys hash is invalid');
    const generation = generationValue === '-' ? undefined : Number(generationValue);
    if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0)) {
      throw new Error('SSH key generation is invalid');
    }
    return {
      processIdentity,
      keyHash,
      generation,
      hostKeyFingerprint: sawHostKeyEnd
        ? sshSha256FingerprintFromDropbearOutput(hostKeyOutput)
        : undefined,
    };
  }

  async getSelfCheckItems(): Promise<SelfCheckItem[]> {
    const binaryItem = await this.checkBinary();
    if (binaryItem.status === 'fail') return [binaryItem];
    const keyUtilityItem = await this.checkDropbearKey();
    if (keyUtilityItem.status === 'fail') return [binaryItem, keyUtilityItem];
    const sftpItem = await this.checkSftpServer();
    const optionsItem = await this.checkOptions();
    return [binaryItem, keyUtilityItem, sftpItem, optionsItem];
  }

  private async reconcileUnlocked(payload: DropbearReconcileInput): Promise<DropbearReconcileResult> {
    this.assertDropbearAssetAvailable();

    const inspect = await this.docker.inspectContainer(payload.runtimeId);
    if (inspect.State.Status !== 'running') {
      throw new Error(`Container ${payload.runtimeId} is not running`);
    }

    if (payload.enabled === false) {
      await this.disableDropbear(payload.runtimeId);
      const at = Date.now();
      return {
        enabled: false,
        status: 'disabled',
        user: 'root',
        port: 22,
        lastReconciledAt: at,
        binaryUpdated: false,
        keysUpdated: false,
        restarted: true,
      };
    }
    this.assertDropbearKeyAssetAvailable();

    const normalizedKeys = this.normalizeKeys([payload.internalPublicKey ?? '']);
    const keyHash = this.sha256(Buffer.from(normalizedKeys));
    const desiredKeyGeneration = payload.internalKeyGeneration;
    if (
      typeof desiredKeyGeneration !== 'number'
      || !Number.isSafeInteger(desiredKeyGeneration)
      || desiredKeyGeneration <= 0
    ) {
      throw new Error('SSH key generation must be a positive safe integer');
    }
    if (payload.expectedKeyHash && payload.expectedKeyHash !== keyHash) {
      throw new Error('SSH key hash mismatch');
    }

    try {
      const [previousKeyHash, previousKeyGeneration] = await Promise.all([
        this.readAuthorizedKeysHash(payload.runtimeId),
        this.readAppliedKeyGeneration(payload.runtimeId),
      ]);
      if (previousKeyGeneration !== undefined && previousKeyGeneration > desiredKeyGeneration) {
        throw new Error(
          `Refusing stale SSH key generation ${desiredKeyGeneration}; container already applied ${previousKeyGeneration}`,
        );
      }
      if (
        previousKeyGeneration === desiredKeyGeneration
        && previousKeyHash !== undefined
        && previousKeyHash !== keyHash
      ) {
        throw new Error(`SSH key generation ${desiredKeyGeneration} conflicts with the applied key hash`);
      }
      let processIdentity = await this.readRunningProcess(payload.runtimeId);
      const binaryNeedsUpdate = await this.containerExecutableNeedsUpdate(
        payload.runtimeId,
        this.asset.binaryPath,
        CONTAINER_BINARY_HASH,
        'Dropbear binary',
      );
      this.assertSftpServerAssetAvailable();
      const sftpServerNeedsUpdate = await this.containerExecutableNeedsUpdate(
        payload.runtimeId,
        this.asset.sftpServerPath!,
        CONTAINER_SFTP_SERVER_HASH,
        'SFTP server',
      );

      // Never replace an executable underneath a live process. Apart from
      // avoiding a mixed old-process/new-file state, this makes a retry after
      // an unconfirmed stop observe the same pre-mutation state.
      let restarted = false;
      if (processIdentity && (binaryNeedsUpdate || sftpServerNeedsUpdate)) {
        await this.stopDropbear(payload.runtimeId, processIdentity);
        processIdentity = null;
        restarted = true;
      }

      await this.ensureRootSshFiles(payload.runtimeId, normalizedKeys);
      await this.writeAppliedKeyGeneration(payload.runtimeId, desiredKeyGeneration);
      const binaryUpdated = await this.ensureBinary(payload.runtimeId, processIdentity?.pid ?? null);
      await this.ensureDropbearKey(payload.runtimeId);
      await this.ensureSftpServer(payload.runtimeId, processIdentity?.pid ?? null);
      await this.execShell(payload.runtimeId, `mkdir -p ${this.q(DROPBEAR_DIR)} /run && chown root:root ${this.q(DROPBEAR_DIR)} && chmod 700 ${this.q(DROPBEAR_DIR)}`);
      await this.ensureHostKey(payload.runtimeId, processIdentity?.pid ?? null);

      if (!processIdentity) {
        await this.startDropbear(payload.runtimeId);
        processIdentity = await this.readRunningProcess(payload.runtimeId);
      }
      if (!processIdentity) {
        throw new Error('Dropbear did not create a running pid file');
      }
      const hostKeyFingerprint = await this.readHostKeyFingerprint(payload.runtimeId);
      if (!hostKeyFingerprint) {
        throw new Error('Dropbear did not expose a valid Ed25519 public host key');
      }

      const at = Date.now();
      return {
        enabled: true,
        status: 'running',
        user: 'root',
        port: 22,
        pid: processIdentity.pid,
        keyHash,
        appliedKeyGeneration: payload.internalKeyGeneration,
        hostKeyFingerprint,
        lastReconciledAt: at,
        binaryUpdated,
        keysUpdated: previousKeyHash !== keyHash,
        restarted,
      };
    } catch (e) {
      throw e;
    }
  }

  private async disableDropbear(dockerId: string): Promise<void> {
    const processIdentity = await this.readRunningProcess(dockerId);
    if (processIdentity) {
      await this.stopDropbear(dockerId, processIdentity);
    }
    await this.execShell(
      dockerId,
      [
        `rm -f ${this.q(PID_FILE)} ${this.q(KEY_GENERATION_FILE)}`,
        `rm -f ${this.q(AUTHORIZED_KEYS)}`,
        `rm -f ${this.q(CONTAINER_BINARY)} ${this.q(CONTAINER_BINARY_HASH)}`,
        `rm -f ${this.q(CONTAINER_DROPBEARKEY)} ${this.q(CONTAINER_DROPBEARKEY_HASH)}`,
        `rm -f ${this.q(CONTAINER_SFTP_SERVER)} ${this.q(CONTAINER_SFTP_SERVER_HASH)}`,
        `rm -f ${this.q(`${DROPBEAR_DIR}/dropbear_rsa_host_key`)} ${this.q(`${DROPBEAR_DIR}/dropbear_dss_host_key`)} ${this.q(`${DROPBEAR_DIR}/dropbear_ecdsa_host_key`)} ${this.q(`${DROPBEAR_DIR}/dropbear_ed25519_host_key`)}`,
      ].join(' && '),
    );
  }

  private async ensureRootSshFiles(dockerId: string, authorizedKeys: string): Promise<void> {
    await this.execShell(dockerId, `mkdir -p ${this.q(ROOT_SSH_DIR)} && chown root:root /root ${this.q(ROOT_SSH_DIR)} && chmod 700 ${this.q(ROOT_SSH_DIR)}`);
    const tmp = `${AUTHORIZED_KEYS}.tmp`;
    await this.docker.putManagementFile(dockerId, tmp, Buffer.from(authorizedKeys, 'utf-8'), 0o600);
    await this.execShell(dockerId, `chmod 600 ${this.q(tmp)} && chown root:root ${this.q(tmp)} && mv -f ${this.q(tmp)} ${this.q(AUTHORIZED_KEYS)}`);
  }

  private async ensureBinary(dockerId: string, runningPid: number | null): Promise<boolean> {
    return this.ensureContainerExecutable(
      dockerId,
      this.asset.binaryPath,
      CONTAINER_BINARY,
      CONTAINER_BINARY_HASH,
      'Dropbear binary',
      runningPid,
    );
  }

  private async ensureSftpServer(dockerId: string, runningPid: number | null): Promise<boolean> {
    this.assertSftpServerAssetAvailable();
    return this.ensureContainerExecutable(
      dockerId,
      this.asset.sftpServerPath!,
      CONTAINER_SFTP_SERVER,
      CONTAINER_SFTP_SERVER_HASH,
      'SFTP server',
      runningPid,
    );
  }

  private async ensureDropbearKey(dockerId: string): Promise<boolean> {
    this.assertDropbearKeyAssetAvailable();
    return this.ensureContainerExecutable(
      dockerId,
      this.asset.dropbearKeyPath!,
      CONTAINER_DROPBEARKEY,
      CONTAINER_DROPBEARKEY_HASH,
      'Dropbear key utility',
      null,
    );
  }

  private async containerExecutableNeedsUpdate(
    dockerId: string,
    sourcePath: string,
    hashPath: string,
    label: string,
  ): Promise<boolean> {
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw new Error(`${label} not found: ${sourcePath || '(not configured)'}`);
    }
    const expectedHash = this.sha256(fs.readFileSync(sourcePath));
    const existing = await this.readTextFile(dockerId, hashPath);
    return existing?.trim() !== expectedHash;
  }

  private async ensureContainerExecutable(
    dockerId: string,
    sourcePath: string,
    containerPath: string,
    hashPath: string,
    label: string,
    runningPid: number | null,
  ): Promise<boolean> {
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw new Error(`${label} not found: ${sourcePath || '(not configured)'}`);
    }
    const binary = fs.readFileSync(sourcePath);
    const hash = this.sha256(binary);
    const existing = await this.readTextFile(dockerId, hashPath);
    if (existing?.trim() === hash) return false;
    if (runningPid) {
      throw new Error(`Refusing to replace ${label} while verified pid ${runningPid} is running`);
    }

    await this.execShell(dockerId, `mkdir -p ${this.q(pathDirname(containerPath))}`);
    const tmp = `${containerPath}.tmp`;
    await this.docker.putManagementFile(dockerId, tmp, binary, 0o755);
    await this.execShell(
      dockerId,
      [
        `chmod 755 ${this.q(tmp)}`,
        `chown root:root ${this.q(tmp)}`,
        `mv -f ${this.q(tmp)} ${this.q(containerPath)}`,
        `printf %s ${this.q(hash)} > ${this.q(hashPath)}`,
        `chmod 644 ${this.q(hashPath)}`,
        `chown root:root ${this.q(hashPath)}`,
      ].join(' && '),
    );
    return true;
  }

  private async startDropbear(dockerId: string): Promise<void> {
    const supportsA = await this.binarySupportsA();
    const args = [
      '-s',
      '-r',
      ED25519_HOST_KEY,
      '-p',
      '0.0.0.0:22',
      '-P',
      PID_FILE,
      ...(supportsA ? ['-a'] : []),
    ];
    await this.execShell(dockerId, `${this.q(CONTAINER_BINARY)} ${args.map((a) => this.q(a)).join(' ')}`);
  }

  private async ensureHostKey(dockerId: string, runningPid: number | null): Promise<void> {
    const tmp = `${ED25519_HOST_KEY}.tmp`;
    await this.execShell(dockerId, [
      `if ${this.q(CONTAINER_DROPBEARKEY)} -y -f ${this.q(ED25519_HOST_KEY)} >/dev/null 2>&1; then`,
      `  chmod 600 ${this.q(ED25519_HOST_KEY)}`,
      `  chown root:root ${this.q(ED25519_HOST_KEY)}`,
      `else`,
      `  [ ${runningPid === null ? "''" : this.q(String(runningPid))} = '' ] || exit 42`,
      `  rm -f ${this.q(tmp)}`,
      `  ${this.q(CONTAINER_DROPBEARKEY)} -t ed25519 -f ${this.q(tmp)}`,
      `  chmod 600 ${this.q(tmp)}`,
      `  chown root:root ${this.q(tmp)}`,
      `  mv -f ${this.q(tmp)} ${this.q(ED25519_HOST_KEY)}`,
      `  ${this.q(CONTAINER_DROPBEARKEY)} -y -f ${this.q(ED25519_HOST_KEY)} >/dev/null`,
      `fi`,
    ].join('\n'));
  }

  private async readRunningProcess(dockerId: string): Promise<RunningProcessIdentity | null> {
    const result = await this.docker.execManagementCapture(dockerId, [
      '/bin/sh',
      '-c',
      [
        `pid="$(cat ${this.q(PID_FILE)} 2>/dev/null || true)"`,
        `case "$pid" in ''|*[!0-9]*) exit 1;; esac`,
        `[ "$pid" -gt 1 ] || exit 42`,
        `kill -0 "$pid" 2>/dev/null || exit 1`,
        `exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"`,
        `[ "$exe" = ${this.q(CONTAINER_BINARY)} ] || exit 42`,
        this.processArgvIdentityShell(),
        `started="$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null)"`,
        `case "$started" in ''|*[!0-9]*) exit 42;; esac`,
        `printf '%s:%s' "$pid" "$started"`,
      ].join('; '),
    ]);
    if (result.exitCode === 1) return null;
    if (result.exitCode !== 0) {
      throw new Error(`Dropbear pid file does not identify ${CONTAINER_BINARY}`);
    }
    const match = /^(\d+):(\d+)$/.exec(result.stdout.trim());
    if (!match) throw new Error('Dropbear pid identity output is invalid');
    const pid = Number.parseInt(match[1], 10);
    return Number.isSafeInteger(pid) && pid > 1 ? { pid, startTime: match[2] } : null;
  }

  private async stopDropbear(dockerId: string, processIdentity: RunningProcessIdentity): Promise<void> {
    const { pid, startTime } = processIdentity;
    await this.execShell(dockerId, [
      `pid=${pid}`,
      `expected_started=${this.q(startTime)}`,
      `[ "$pid" -gt 1 ]`,
      `started="$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)"`,
      `[ -n "$started" ] || exit 0`,
      `[ "$started" = "$expected_started" ] || exit 42`,
      `exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"`,
      `[ "$exe" = ${this.q(CONTAINER_BINARY)} ]`,
      this.processArgvIdentityShell(),
      `kill "$pid"`,
      `i=0`,
      `while kill -0 "$pid" 2>/dev/null; do`,
      `  current="$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)"`,
      `  [ "$current" = "$expected_started" ] || break`,
      `  i=$((i + 1))`,
      `  [ "$i" -lt 50 ] || exit 1`,
      `  sleep 0.1`,
      `done`,
    ].join('; '));
  }

  private async readAuthorizedKeysHash(dockerId: string): Promise<string | undefined> {
    const result = await this.docker.execManagementCapture(dockerId, [
      '/bin/sh',
      '-c',
      `test -f ${this.q(AUTHORIZED_KEYS)} && sha256sum ${this.q(AUTHORIZED_KEYS)} | awk '{print $1}'`,
    ]);
    if (result.exitCode !== 0) return undefined;
    const hash = result.stdout.trim();
    return hash || undefined;
  }

  private async readAppliedKeyGeneration(dockerId: string): Promise<number | undefined> {
    const text = await this.readTextFile(dockerId, KEY_GENERATION_FILE);
    if (!text) return undefined;
    const value = Number(text.trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }

  private async readHostKeyFingerprint(dockerId: string): Promise<string | undefined> {
    const result = await this.docker.execManagementCapture(dockerId, [
      '/bin/sh',
      '-c',
      `test -s ${this.q(ED25519_HOST_KEY)} && ${this.q(CONTAINER_DROPBEARKEY)} -y -f ${this.q(ED25519_HOST_KEY)}`,
    ]);
    if (result.exitCode !== 0) return undefined;
    return sshSha256FingerprintFromDropbearOutput(`${result.stdout}\n${result.stderr}`);
  }

  private async writeAppliedKeyGeneration(dockerId: string, generation: number): Promise<void> {
    await this.execShell(
      dockerId,
      `printf %s ${this.q(String(generation))} > ${this.q(KEY_GENERATION_FILE)} && chmod 600 ${this.q(KEY_GENERATION_FILE)} && chown root:root ${this.q(KEY_GENERATION_FILE)}`,
    );
  }

  private async readTextFile(dockerId: string, filePath: string): Promise<string | null> {
    const result = await this.docker.execManagementCapture(dockerId, ['/bin/sh', '-c', `cat ${this.q(filePath)} 2>/dev/null`]);
    if (result.exitCode !== 0) return null;
    return result.stdout;
  }

  private async execShell(dockerId: string, script: string): Promise<string> {
    const result = await this.docker.execManagementCapture(dockerId, ['/bin/sh', '-c', script], 30_000);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `shell exited ${result.exitCode}`);
    }
    return result.stdout;
  }

  private processArgvIdentityShell(): string {
    return [
      `argv="$(tr '\\000' '\\n' < "/proc/$pid/cmdline" 2>/dev/null)"`,
      `if [ "$argv" != ${this.q(expectedDropbearArgv(false))} ] && [ "$argv" != ${this.q(expectedDropbearArgv(true))} ]; then exit 42; fi`,
    ].join('\n');
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

  private readExpectedSftpServerSha256(): string | null {
    if (!this.asset.sftpServerSha256Path || !fs.existsSync(this.asset.sftpServerSha256Path)) return null;
    const raw = fs.readFileSync(this.asset.sftpServerSha256Path, 'utf-8').trim();
    return raw.split(/\s+/)[0] || null;
  }

  private readExpectedDropbearKeySha256(): string | null {
    if (!this.asset.dropbearKeySha256Path || !fs.existsSync(this.asset.dropbearKeySha256Path)) return null;
    const raw = fs.readFileSync(this.asset.dropbearKeySha256Path, 'utf-8').trim();
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

  private assertSftpServerAssetAvailable(): void {
    if (!this.asset.sftpServerPath || !fs.existsSync(this.asset.sftpServerPath)) {
      throw new Error(`SFTP server asset not found: ${this.asset.sftpServerPath || '(not configured)'}`);
    }
  }

  private assertDropbearKeyAssetAvailable(): void {
    if (!this.asset.dropbearKeyPath || !fs.existsSync(this.asset.dropbearKeyPath)) {
      throw new Error(`Dropbear key utility not found: ${this.asset.dropbearKeyPath || '(not configured)'}`);
    }
  }

  private async checkDropbearKey(): Promise<SelfCheckItem> {
    try {
      this.assertDropbearKeyAssetAvailable();
      const binary = fs.readFileSync(this.asset.dropbearKeyPath!);
      const hash = this.sha256(binary);
      const stat = fs.statSync(this.asset.dropbearKeyPath!);
      if ((stat.mode & 0o111) === 0) {
        return { id: 'dropbear_key_binary', label: 'Dropbear key utility', status: 'fail', message: `${this.asset.dropbearKeyPath} is not executable` };
      }
      const expected = this.readExpectedDropbearKeySha256();
      if (expected && expected !== hash) {
        return { id: 'dropbear_key_binary', label: 'Dropbear key utility', status: 'fail', message: `sha256 mismatch for ${this.asset.dropbearKeyPath}` };
      }
      return {
        id: 'dropbear_key_binary',
        label: 'Dropbear key utility',
        status: expected ? 'ok' : 'warn',
        message: expected
          ? `Dropbear key utility OK (${this.asset.source}, sha256 ${hash.slice(0, 12)})`
          : `Dropbear key utility executable but no sha256 sidecar found (${this.asset.source})`,
      };
    } catch (e) {
      return { id: 'dropbear_key_binary', label: 'Dropbear key utility', status: 'fail', message: this.errorMessage(e) };
    }
  }

  private async checkSftpServer(): Promise<SelfCheckItem> {
    try {
      this.assertSftpServerAssetAvailable();
      const binary = fs.readFileSync(this.asset.sftpServerPath!);
      const hash = this.sha256(binary);
      const stat = fs.statSync(this.asset.sftpServerPath!);
      if ((stat.mode & 0o111) === 0) {
        return { id: 'sftp_server_binary', label: 'SFTP server binary', status: 'fail', message: `${this.asset.sftpServerPath} is not executable` };
      }
      const expected = this.readExpectedSftpServerSha256();
      if (expected && expected !== hash) {
        return { id: 'sftp_server_binary', label: 'SFTP server binary', status: 'fail', message: `sha256 mismatch for ${this.asset.sftpServerPath}` };
      }
      return {
        id: 'sftp_server_binary',
        label: 'SFTP server binary',
        status: expected ? 'ok' : 'warn',
        message: expected
          ? `SFTP server asset OK (${this.asset.source}, sha256 ${hash.slice(0, 12)})`
          : `SFTP server asset executable but no sha256 sidecar found (${this.asset.source})`,
      };
    } catch (e) {
      return { id: 'sftp_server_binary', label: 'SFTP server binary', status: 'fail', message: this.errorMessage(e) };
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

function pathDirname(value: string): string {
  const index = value.lastIndexOf('/');
  return index > 0 ? value.slice(0, index) : '/';
}
