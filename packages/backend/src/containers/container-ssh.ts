import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { IntentKind, IntentResourceType } from '@nyabase/common';
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
  readonly desiredContent: string;
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
    return { status: 'unknown', lastError: null };
  }
  return { status: 'running', lastError: null };
}

/** Write the owner's authorized_keys into the guest and probe sshd when the instance runs. */
export async function reconcileSshFile(
  sshState: IncusContainerSshStateAdapter,
  client: IncusClientPort,
  row: ContainerRow,
  name: string,
  instanceRunning: boolean,
  signal: AbortSignal,
): Promise<SshFileObservation> {
  if (!row.ssh_public_key) {
    return { status: 'disabled', lastError: null };
  }
  const content = `${row.ssh_public_key.trim()}\n`;
  const path = row.login_user === 'root'
    ? '/root/.ssh/authorized_keys'
    : `/home/${row.login_user}/.ssh/authorized_keys`;
  const homeMetadata = row.login_user === 'root'
    ? null
    : await sshState.readHomeDirectoryMetadata(client, name, `/home/${row.login_user}`, signal);
  const desiredMetadata = sshFileMetadata(row.login_user, homeMetadata);
  let actual = await sshState.readAuthorizedKeys(client, name, path, signal);
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

  if (!instanceRunning) {
    return { status: 'container_stopped', lastError: null };
  }
  const sshd = await sshState.probeSshd(client, name, signal);
  const observation = sshObservation(sshd);
  if (observation.status === 'unknown') {
    // Key is applied but sshd is not accepting connections yet — retry rather
    // than settling create as succeeded with a false "ready" signal.
    throw new IncusError('SSH_DAEMON_PENDING', 'retry', {
      reason: 'sshd_not_listening',
      path,
    });
  }
  return observation;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
    content: string,
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
    let result;
    try {
      result = await requestAndWait(
        client,
        (options) => client.execInstance(
          instanceName,
          {
            command: [...SSHD_PROBE_COMMAND],
            'record-output': false,
          },
          options,
        ),
        { signal },
      );
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
      // Incus marks guest exec 127 as operation Failure "Command not found".
      // That is sshd absence, not an Incus transport failure.
      if (error instanceof IncusError && error.code === 'OPERATION_FAILED') {
        const code = operationReturnCode(error.details);
        if (code === 127) return 'missing';
        if (code === 2) return 'unknown';
      }
      throw error;
    }
    if (result.kind !== 'completed') return 'unknown';
    const code = operationReturnCode(result.metadata);
    if (code === undefined) return 'unknown';
    if (code === 0) return 'present';
    if (code === 127) return 'missing';
    // Exit 2: sshd binary exists but is not accepting connections yet.
    return 'unknown';
  }
}

// --- key convergence (queue a container.update so keys are rewritten) ---------

type SshSyncOperation = 'sync_user_ssh_keys' | 'repair_ssh';

@Injectable()
export class ContainerSshConvergenceService {
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
