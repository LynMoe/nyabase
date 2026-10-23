import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { IntentKind, IntentResourceType, sshContainerHostName } from '@nyabase/common';
import type { Kysely } from 'kysely';
import {
  IncusError,
  requestAndWait,
  type IncusClientPort,
  type IncusFileResponse,
} from '../incus/index.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { retryPgTransaction } from '../platform/persistence-pg/transaction.js';
import { executeWithPostCommit } from '../platform/post-commit.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { isNotFound } from './container-instance-ops.js';
import type { ContainerRow, SshFileObservation } from './container-reconcile.store.js';
import { isRecord } from '../platform/domain-utils.js';
import { parseEd25519PublicKey } from '../ssh-host-ca/ssh-certificates.js';

export interface SshFileMetadataExpectation {
  readonly uid?: number;
  readonly gid?: number;
  readonly mode: number;
  readonly type: 'file';
}

export function sshFileMetadataMatches(
  actual: {
    readonly uid?: number;
    readonly gid?: number;
    readonly mode?: number;
    readonly type?: string;
  },
  desired: SshFileMetadataExpectation,
): boolean {
  return actual.mode === desired.mode
    && actual.type === desired.type
    && (desired.uid === undefined || actual.uid === desired.uid)
    && (desired.gid === undefined || actual.gid === desired.gid);
}

export function sshFileNeedsReconcile(input: {
  readonly actual: {
    readonly body: Buffer;
    readonly uid?: number;
    readonly gid?: number;
    readonly mode?: number;
    readonly type?: string;
  } | null;
  readonly desiredContent: string | Buffer;
  readonly desiredMetadata: SshFileMetadataExpectation;
}): boolean {
  if (!input.actual) return true;
  const desiredHash = createHash('sha256').update(input.desiredContent).digest('hex');
  const actualHash = createHash('sha256').update(input.actual.body).digest('hex');
  return desiredHash !== actualHash
    || !sshFileMetadataMatches(input.actual, input.desiredMetadata);
}

export function sshFileMetadata(
  loginUser: string,
  owner?: { readonly uid?: number; readonly gid?: number } | null,
): SshFileMetadataExpectation {
  return loginUser === 'root'
    ? { uid: 0, gid: 0, mode: 0o600, type: 'file' }
    : { uid: owner?.uid, gid: owner?.gid, mode: 0o600, type: 'file' };
}

export function sshObservation(sshd: SshdPresence): SshFileObservation {
  if (sshd === 'missing') {
    return {
      status: 'error',
      lastError: 'key_applied_sshd_missing',
    };
  }
  if (sshd === 'unknown') {
    return { status: 'unknown', lastError: 'sshd_not_listening' };
  }
  return { status: 'running', lastError: null };
}

/** The platform's part of authorized_keys; everything outside it belongs to the user. */
export const MANAGED_KEYS_BEGIN = '# >>> nyabase: platform SSH keys, rewritten on every sync >>>';
export const MANAGED_KEYS_END = '# <<< nyabase <<<';

/**
 * `current` with its managed block replaced by `keys` (dropped when there are
 * none) and placed last; every other line is kept as written. A block whose
 * end marker was deleted runs to the end of the file, so stale platform keys
 * cannot survive a damaged marker.
 */
export function withManagedKeys(current: string, keys: string | null): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const line of current.split('\n')) {
    if (line.trim() === MANAGED_KEYS_BEGIN) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (line.trim() === MANAGED_KEYS_END) inBlock = false;
      continue;
    }
    if (line.trim() === MANAGED_KEYS_END) continue;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop();
  const managed = keys ? [MANAGED_KEYS_BEGIN, ...keys.split('\n'), MANAGED_KEYS_END] : [];
  const lines = [...kept, ...managed];
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * Keep the owner's platform keys in the guest's authorized_keys (a managed
 * block; lines the user added stay) and probe sshd when the instance runs.
 */
export async function reconcileSshFile(
  sshState: IncusContainerSshStateAdapter,
  client: IncusClientPort,
  row: ContainerRow,
  name: string,
  instanceRunning: boolean,
  signal: AbortSignal,
): Promise<SshFileObservation> {
  const path = row.login_user === 'root'
    ? '/root/.ssh/authorized_keys'
    : `/home/${row.login_user}/.ssh/authorized_keys`;
  let actual = await sshState.readAuthorizedKeys(client, name, path, signal);
  const keys = row.ssh_public_key?.trim() || null;
  // No keys and no file: nothing to manage, and no file to create.
  if (!keys && !actual) return { status: 'disabled', lastError: null };
  // A symlink (dotfiles) or directory is the user's; never write through it.
  if (actual && actual.type !== undefined && actual.type !== 'file') {
    return keys
      ? { status: 'error', lastError: 'authorized_keys_not_a_file' }
      : { status: 'disabled', lastError: null };
  }
  // latin1 maps bytes 1:1, so user lines that are not UTF-8 are written back unchanged.
  const content = Buffer.from(withManagedKeys(actual?.body.toString('latin1') ?? '', keys), 'latin1');
  const homeMetadata = row.login_user === 'root'
    ? null
    : await sshState.readHomeDirectoryMetadata(client, name, `/home/${row.login_user}`, signal);
  const desiredMetadata = sshFileMetadata(row.login_user, homeMetadata);
  if (sshFileNeedsReconcile({ actual, desiredContent: content, desiredMetadata })) {
    try {
      await sshState.writeAuthorizedKeys(client, name, path, content, desiredMetadata, signal);
    } catch (error) {
      if (!(error instanceof IncusError) || error.code !== 'INCUS_TIMEOUT') throw error;
      const afterTimeout = await sshState.readAuthorizedKeys(client, name, path, signal);
      if (sshFileNeedsReconcile({
        actual: afterTimeout,
        desiredContent: content,
        desiredMetadata,
      })) {
        throw error;
      }
    }
    actual = await sshState.readAuthorizedKeys(client, name, path, signal);
  }
  if (sshFileNeedsReconcile({ actual, desiredContent: content, desiredMetadata })) {
    throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
      reason: 'ssh_file_state_mismatch',
      path,
    });
  }
  if (!keys) return { status: 'disabled', lastError: null };

  if (!instanceRunning) {
    return { status: 'container_stopped', lastError: null };
  }
  const sshd = await sshState.probeSshd(client, name, signal);
  // `unknown` (key applied, nothing listening on 127.0.0.1:22) is recorded as
  // observed; the reconciler decides whether this intent waits for sshd.
  return sshObservation(sshd);
}

// --- Incus guest file and sshd access ----------------------------------------

export type SshdPresence = 'present' | 'missing' | 'unknown';

const SSHD_PROBE_COMMAND = [
  'bash',
  '-c',
  [
    'if ! command -v sshd >/dev/null 2>&1; then exit 127; fi',
    'if echo >/dev/tcp/127.0.0.1/22 2>/dev/null; then exit 0; fi',
    // Plan D23: image owns sshd; control plane must ensure the service is up.
    'systemctl start ssh 2>/dev/null || systemctl start sshd 2>/dev/null || service ssh start 2>/dev/null || true',
    'for _ in 1 2 3 4 5 6 7 8; do if echo >/dev/tcp/127.0.0.1/22 2>/dev/null; then exit 0; fi; sleep 1; done',
    'exit 2',
  ].join('; '),
] as const;

function operationReturnCode(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.return === 'number' && Number.isSafeInteger(value.return)) {
    return value.return;
  }
  return operationReturnCode(value.metadata);
}

function parentDirectory(path: string): string | null {
  const trimmed = path.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  if (index <= 0) return null;
  return trimmed.slice(0, index);
}

@Injectable()
export class IncusContainerSshStateAdapter {
  async readHomeDirectoryMetadata(
    client: IncusClientPort,
    instanceName: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ readonly uid?: number; readonly gid?: number } | null> {
    try {
      const file = await client.getFile(instanceName, path, { signal });
      return { uid: file.uid, gid: file.gid };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async readAuthorizedKeys(
    client: IncusClientPort,
    instanceName: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<IncusFileResponse | null> {
    try {
      return await client.getFile(instanceName, path, { signal });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async writeAuthorizedKeys(
    client: IncusClientPort,
    instanceName: string,
    path: string,
    content: string | Buffer,
    metadata?: {
      readonly uid?: number;
      readonly gid?: number;
      readonly mode?: number;
      readonly type?: 'file';
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const parent = parentDirectory(path);
    if (parent) {
      await this.ensureDirectory(client, instanceName, parent, {
        uid: metadata?.uid,
        gid: metadata?.gid,
        mode: 0o700,
      }, signal);
    }
    await client.putFile(instanceName, path, content, {
      uid: metadata?.uid,
      gid: metadata?.gid,
      mode: metadata?.mode ?? 0o600,
      type: metadata?.type ?? 'file',
      write: 'overwrite',
      signal,
    });
  }

  private async ensureDirectory(
    client: IncusClientPort,
    instanceName: string,
    path: string,
    metadata: {
      readonly uid?: number;
      readonly gid?: number;
      readonly mode: number;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const existing = await client.getFile(instanceName, path, { signal });
      if (existing.type === 'directory') return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await client.putFile(instanceName, path, Buffer.alloc(0), {
      uid: metadata.uid,
      gid: metadata.gid,
      mode: metadata.mode,
      type: 'directory',
      signal,
    });
  }

  async probeSshd(
    client: IncusClientPort,
    instanceName: string,
    signal?: AbortSignal,
  ): Promise<SshdPresence> {
    let code: number | undefined;
    try {
      code = await this.runScript(client, instanceName, SSHD_PROBE_COMMAND, signal);
    } catch (error) {
      // Start/reconcile races: /state can report Running briefly before exec is admitted.
      if (
        error instanceof IncusError
        && (error.code === 'INCUS_BAD_REQUEST' || error.code === 'INSTANCE_BUSY')
        && typeof error.details?.error === 'string'
        && /not running|busy/i.test(error.details.error)
      ) {
        return 'unknown';
      }
      throw error;
    }
    if (code === 0) return 'present';
    if (code === 127) return 'missing';
    // Exit 2: sshd binary exists but is not accepting connections yet.
    return 'unknown';
  }

  /** A guest file's text, or null when it does not exist. */
  async readText(
    client: IncusClientPort,
    instanceName: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const file = await this.readAuthorizedKeys(client, instanceName, path, signal);
    return file && file.type !== 'directory' ? file.body.toString('utf8') : null;
  }

  async isDirectory(
    client: IncusClientPort,
    instanceName: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const file = await this.readAuthorizedKeys(client, instanceName, path, signal);
    return file?.type === 'directory';
  }

  /** Writes a root-owned, world-readable file. */
  async writeRootFile(
    client: IncusClientPort,
    instanceName: string,
    path: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await client.putFile(instanceName, path, content, {
      uid: 0,
      gid: 0,
      mode: 0o644,
      type: 'file',
      write: 'overwrite',
      signal,
    });
  }

  /**
   * Runs `command` in the guest and returns its exit code (undefined when
   * Incus did not report one). Incus turns a non-zero exit into a failed
   * operation; that is an exit code here, not a transport error.
   */
  async runScript(
    client: IncusClientPort,
    instanceName: string,
    command: readonly string[],
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    let result;
    try {
      result = await requestAndWait(
        client,
        (options) => client.execInstance(
          instanceName,
          {
            command: [...command],
            'record-output': false,
          },
          options,
        ),
        { signal },
      );
    } catch (error) {
      if (error instanceof IncusError && error.code === 'OPERATION_FAILED') {
        const code = operationReturnCode(error.details);
        if (code !== undefined) return code;
      }
      throw error;
    }
    if (result.kind !== 'completed') return undefined;
    return operationReturnCode(result.metadata);
  }
}

// --- host certificate -------------------------------------------------------------

const HOST_KEY_PATH = '/etc/ssh/ssh_host_ed25519_key.pub';
const HOST_CERTIFICATE_PATH = '/etc/ssh/ssh_host_ed25519_key-cert.pub';
const SSHD_DROP_IN_DIRECTORY = '/etc/ssh/sshd_config.d';
const SSHD_DROP_IN_PATH = `${SSHD_DROP_IN_DIRECTORY}/50-nyabase-host-certificate.conf`;
const SSHD_DROP_IN = `# Managed by nyabase: present the host certificate for <name>.<suffix>.\nHostCertificate ${HOST_CERTIFICATE_PATH}\n`;
/** Written by the script only after sshd reloaded with this certificate, so a failed reload is retried. */
const HOST_CERTIFICATE_STAMP_PATH = '/etc/ssh/.nyabase-host-certificate-loaded';

/**
 * Check the config before reloading: a config sshd refuses loses our drop-in
 * (exit 3), and one that never includes sshd_config.d is reported (exit 4).
 * A socket-activated sshd has nothing to reload (try-reload is a no-op).
 * `$1` is the stamp recorded once sshd runs with the new certificate.
 */
const SSHD_CERTIFICATE_RELOAD_SCRIPT = [
  'sshd_bin=$(command -v sshd || echo /usr/sbin/sshd)',
  // sshd -t needs its privilege separation directory, absent before a socket-activated first start.
  'mkdir -p -m 0755 /run/sshd 2>/dev/null',
  `if ! "$sshd_bin" -t >/dev/null 2>&1; then rm -f ${SSHD_DROP_IN_PATH}; exit 3; fi`,
  `"$sshd_bin" -T 2>/dev/null | grep -qix 'hostcertificate ${HOST_CERTIFICATE_PATH}' || exit 4`,
  'systemctl try-reload-or-restart ssh.service >/dev/null 2>&1'
    + ' || systemctl try-reload-or-restart sshd.service >/dev/null 2>&1'
    + ' || { pid=$(cat /run/sshd.pid 2>/dev/null) && kill -HUP "$pid" 2>/dev/null; } || exit 5',
  `printf '%s\\n' "$1" > ${HOST_CERTIFICATE_STAMP_PATH}`,
].join('; ');

export type HostCertificateOutcome =
  | 'current'
  | 'issued'
  | 'no_host_key'
  | 'no_drop_in_directory'
  | 'unavailable'
  | 'config_rejected'
  | 'not_included'
  | 'reload_failed';

/** `work.nya` and `work`: the names a user connects to the container by. */
export function hostCertificatePrincipals(containerName: string, hostSuffix: string): string[] {
  const name = containerName.toLowerCase();
  const qualified = sshContainerHostName(containerName, hostSuffix);
  return qualified === name ? [name] : [qualified, name];
}

/**
 * Give the guest's Ed25519 host key a certificate from the owner's CA and make
 * sshd present it. Best effort: without it users fall back to trust-on-first-use.
 * Certificates are deterministic, so a converged guest costs two reads.
 */
export async function reconcileHostCertificate(
  sshState: IncusContainerSshStateAdapter,
  client: IncusClientPort,
  name: string,
  certify: (hostPublicKey: string) => Promise<string | null>,
  beforeExec: () => Promise<void>,
  signal: AbortSignal,
): Promise<HostCertificateOutcome> {
  const hostKey = await sshState.readText(client, name, HOST_KEY_PATH, signal);
  if (!hostKey || !parseEd25519PublicKey(hostKey)) return 'no_host_key';
  const certificate = await certify(hostKey.trim());
  if (!certificate) return 'unavailable';
  const desired = `${certificate}\n`;
  const stamp = createHash('sha256').update(desired).digest('hex');
  const [currentCertificate, currentDropIn, currentStamp] = await Promise.all([
    sshState.readText(client, name, HOST_CERTIFICATE_PATH, signal),
    sshState.readText(client, name, SSHD_DROP_IN_PATH, signal),
    sshState.readText(client, name, HOST_CERTIFICATE_STAMP_PATH, signal),
  ]);
  if (currentCertificate === desired && currentDropIn === SSHD_DROP_IN && currentStamp?.trim() === stamp) {
    return 'current';
  }
  if (!await sshState.isDirectory(client, name, SSHD_DROP_IN_DIRECTORY, signal)) return 'no_drop_in_directory';
  await sshState.writeRootFile(client, name, HOST_CERTIFICATE_PATH, desired, signal);
  await sshState.writeRootFile(client, name, SSHD_DROP_IN_PATH, SSHD_DROP_IN, signal);
  await beforeExec();
  switch (await sshState.runScript(client, name, ['bash', '-c', SSHD_CERTIFICATE_RELOAD_SCRIPT, '_', stamp], signal)) {
    case 0: return 'issued';
    case 3: return 'config_rejected';
    case 4: return 'not_included';
    default: return 'reload_failed';
  }
}

// --- key convergence (queue a container.update so keys are rewritten) ---------

type SshSyncOperation = 'sync_user_ssh_keys' | 'repair_ssh' | 'sync_host_certificate';

@Injectable()
export class ContainerSshConvergenceService {
  private readonly logger = new Logger(ContainerSshConvergenceService.name);

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly intents: IntentRepository,
  ) {}

  async reconcileUser(userId: string): Promise<void> {
    const containers = await this.database.selectFrom('control.containers')
      .select(['id'])
      .where('owner_id', '=', userId)
      .where('lifecycle_phase', '=', 'active')
      .execute();
    for (const container of containers) {
      await this.enqueueContainerSshSync(container.id, 'sync_user_ssh_keys');
    }
  }

  /**
   * Re-sign every active container's host certificate: after the host suffix
   * changed (new principals) or the host CAs were reset. Returns how many
   * containers were queued.
   */
  async reconcileAllHostCertificates(): Promise<{ queued: number; failed: number }> {
    const containers = await this.database.selectFrom('control.containers')
      .select(['id'])
      .where('lifecycle_phase', '=', 'active')
      .execute();
    let queued = 0;
    let failed = 0;
    for (const container of containers) {
      try {
        if (await this.enqueueContainerSshSync(container.id, 'sync_host_certificate')) queued += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(`Host certificate re-sign of container ${container.id} was not queued: ${String(error)}`);
      }
    }
    this.logger.log(`Host certificate re-sign queued for ${queued} containers (${failed} failed)`);
    return { queued, failed };
  }

  /** Fire and forget: the fleet-wide loop must not hold an HTTP request or settings commit. */
  startReconcileAllHostCertificates(): void {
    void this.reconcileAllHostCertificates().catch((error: unknown) => {
      this.logger.warn(`Host certificate re-sign could not start: ${String(error)}`);
    });
  }

  async repairContainer(containerId: string): Promise<{ woken: boolean }> {
    const woken = await this.enqueueContainerSshSync(containerId, 'repair_ssh');
    return { woken };
  }

  /**
   * SSH key content is not part of the Incus instance document revision gate.
   * Wake alone only drains existing pending intents — it never rewrites authorized_keys.
   * Bump revision + create container.update so reconcileSshFile runs with fresh keys.
   */
  private async enqueueContainerSshSync(
    containerId: string,
    operation: SshSyncOperation,
  ): Promise<boolean> {
    const result = await retryPgTransaction(async () => {
      return executeWithPostCommit(
        this.database.transaction().setIsolationLevel('serializable'),
        async (transaction) => {
          const container = await transaction.selectFrom('control.containers')
            .select(['id', 'server_id', 'revision', 'lifecycle_phase'])
            .where('id', '=', containerId)
            .forUpdate()
            .executeTakeFirst();
          if (!container || container.lifecycle_phase !== 'active') {
            return null;
          }
          const revision = Number(container.revision) + 1;
          const updated = await transaction.updateTable('control.containers')
            .set({ revision })
            .where('id', '=', containerId)
            .where('revision', '=', container.revision)
            .returning(['id', 'server_id', 'revision'])
            .executeTakeFirst();
          if (!updated) {
            throw new Error('CONTAINER_REVISION_CONFLICT');
          }
          const intent = await this.intents.createPending({
            kind: IntentKind.ContainerUpdate,
            resourceType: IntentResourceType.Container,
            resourceId: containerId,
            serverId: updated.server_id,
            targetRevision: updated.revision,
            request: { operation },
          }, transaction);
          return {
            containerId,
            serverId: updated.server_id,
            intentId: intent.id,
          };
        });
    }, { maxAttempts: 5, retryBaseDelayMs: 5 });

    if (!result) {
      return false;
    }
    return true;
  }
}
