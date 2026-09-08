import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AuditAction } from '@nyabase/common';
import { Kysely, sql } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import {
  applyManagedFields,
  compareManagedFields,
  CORE_MANAGED_FIELD_OWNERSHIP,
  deriveInstanceName,
  IncusError,
  isMissingCustomVolumeError,
  observeRootQuotaPending,
  requestAndWait,
  readAfterTimeout,
  type IncusClientPort,
  type IncusSchema,
  type ManagedFieldOwnership,
  type ManagedInstanceDocument,
} from '../incus/index.js';
import {
  buildDesiredInstanceSpec,
  mergeInstanceSpecContributions,
  type DesiredInstanceSpec,
  type InstanceSpecAttachmentInput,
} from '../incus/instance-spec.js';
import { FailureCode, isPackageHttpError } from '@nyabase/common';
import { asJsonObject } from '../server-card-extensions/json.js';
import { ServerCardExtensionRegistry } from '../server-card-extensions/registry.js';
import { ExtensionDeviceClaimsRepository } from '../server-card-extensions/claims.repository.js';
import {
  CONTAINER_SSH_STATE,
  IncusContainerSshStateAdapter,
  type ContainerSshStatePort,
  type SshdPresence,
} from './container-ssh-state.adapter.js';
import {
  applyGuestNetwork,
  parseCidrPrefix,
} from './guest-network.adapter.js';
import { IntentRepository, type IntentFailure, type IntentRecord } from './intent.repository.js';
import type {
  ManagedReconciler,
  ReconcileOutcome,
  ReconcileRunContext,
} from './reconcile-worker.service.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { ensureSharedCatalogOnServer } from '../volumes/shared-catalog.js';
import { VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS } from '../volumes/volume-placement.js';

type InstanceFull = IncusSchema<'InstanceFull'>;
type InstanceState = IncusSchema<'InstanceState'>;

const MANAGED_KEY = 'user.nyabase.managed';
const CONTAINER_ID_KEY = 'user.nyabase.container_id';
const SERVER_ID_KEY = 'user.nyabase.server_id';

interface ContainerRow {
  id: string;
  server_id: string;
  owner_id: string;
  image_id: string;
  generation: number;
  image_fingerprint: string;
  root_size_bytes: string | number;
  cpu_millis: number;
  mem_bytes: string | number;
  extensions: unknown;
  nesting: boolean;
  syscall_intercept: boolean;
  power_intent: 'running' | 'stopped';
  lifecycle_phase: 'provisioning' | 'active' | 'deleting' | 'failed';
  root_pool_name: string;
  root_resize_family: 'quota_online' | 'block_backed';
  parent_interface: string | null;
  routed_ip: string | null;
  network_key: string | null;
  gateway: string | null;
  dns_servers: string[];
  login_user: string;
  ssh_public_key: string | null;
}
interface ContainerAttachment {
  id: string;
  container_path: string;
  read_only: boolean;
  volume_id: string;
  incus_name: string;
  pool_name: string;
  size_bytes: string;
  shared: boolean;
  bind_state: 'attaching' | 'attached' | 'detaching';
}

interface ActualInstance {
  readonly name: string;
  readonly document: InstanceFull;
}

export interface SshFileMetadataExpectation {
  readonly uid?: number;
  readonly gid?: number;
  readonly mode: number;
  readonly type: 'file';
}

export interface SshFileObservation {
  readonly status: 'disabled' | 'container_stopped' | 'running' | 'error' | 'unknown';
  readonly lastError: string | null;
}

export interface ManagedContainerIdentity {
  readonly managed: boolean;
  readonly containerId: string;
  readonly serverId: string;
}

function isNotFound(error: unknown): boolean {
  return error instanceof IncusError && error.code === 'INCUS_NOT_FOUND';
}

function failure(code: string, message: string, details: Record<string, unknown> = {}): IntentFailure {
  return { code, message, details };
}

async function auditIncusMutate(
  audit: AuditService | undefined,
  intent: IntentRecord,
  detail: {
    readonly method: string;
    readonly path: string;
    readonly instanceName?: string;
  },
): Promise<void> {
  if (!audit) return;
  await audit.log(
    intent.requestedBy,
    AuditAction.IncusMutate,
    intent.resourceId,
    intent.resourceType,
    {
      method: detail.method,
      path: detail.path,
      instanceName: detail.instanceName,
      serverId: intent.serverId,
      intentId: intent.id,
    },
  );
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.replaceAll('-', '').toLowerCase() : '';
}

export function managedContainerIdentity(document: InstanceFull): ManagedContainerIdentity {
  const config = document.config ?? {};
  return {
    managed: config[MANAGED_KEY] === 'true',
    containerId: normalized(config[CONTAINER_ID_KEY]),
    serverId: normalized(config[SERVER_ID_KEY]),
  };
}

export function powerTransition(
  currentStatus: string | undefined,
  desired: 'running' | 'stopped',
): 'start' | 'stop' | 'none' {
  const current = currentStatus?.toLowerCase();
  if (desired === 'running') return current === 'running' ? 'none' : 'start';
  return current === 'running' ? 'stop' : 'none';
}

export function restartTransition(
  currentStartedAt: string | null | undefined,
  baselineStartedAt: string | null | undefined,
  currentStatus: string | undefined,
): 'restart' | 'proven' {
  if (
    currentStatus?.toLowerCase() === 'running'
    && currentStartedAt !== baselineStartedAt
  ) {
    return 'proven';
  }
  return 'restart';
}

function running(state: InstanceState | undefined): boolean {
  return state?.status?.toLowerCase() === 'running';
}

export function observedDiskUsageBytes(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function bytes(value: unknown): bigint | null {
  return observedDiskUsageBytes(value);
}

export type RootShrinkBlock = 'usage_unknown' | 'usage_floor' | 'requires_stop';

export function decideRootShrink(input: {
  readonly resizeFamily: 'quota_online' | 'block_backed';
  readonly actualRootBytes: bigint;
  readonly desiredRootBytes: bigint;
  readonly usedBytes: bigint | null;
  readonly running: boolean;
}): 'allow' | RootShrinkBlock {
  if (input.desiredRootBytes >= input.actualRootBytes) return 'allow';
  if (input.resizeFamily === 'block_backed' && input.running) return 'requires_stop';
  if (input.resizeFamily === 'quota_online' && (input.usedBytes === null || input.usedBytes <= 0n)) {
    return 'usage_unknown';
  }
  if (input.usedBytes !== null && input.desiredRootBytes < input.usedBytes) return 'usage_floor';
  return 'allow';
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

function sshFileMetadata(
  loginUser: string,
  owner?: { readonly uid?: number; readonly gid?: number } | null,
): SshFileMetadataExpectation {
  return loginUser === 'root'
    ? { uid: 0, gid: 0, mode: 0o600, type: 'file' }
    : { uid: owner?.uid, gid: owner?.gid, mode: 0o600, type: 'file' };
}

@Injectable()
export class ContainerReconciler implements ManagedReconciler {
  private readonly logger = new Logger(ContainerReconciler.name);
  private readonly sshState: ContainerSshStatePort;

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    @Optional() private readonly intents?: IntentRepository,
    @Optional() @Inject(CONTAINER_SSH_STATE) sshState?: ContainerSshStatePort,
    @Optional() private readonly proxySnapshots?: ProxySnapshotNotifierService,
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly extensions?: ServerCardExtensionRegistry,
    @Optional() private readonly extensionClaims?: ExtensionDeviceClaimsRepository,
  ) {
    this.sshState = sshState ?? new IncusContainerSshStateAdapter();
  }

  private ownership(): ManagedFieldOwnership {
    return this.extensions?.managedFieldOwnership() ?? CORE_MANAGED_FIELD_OWNERSHIP;
  }

  private async desiredSpec(
    row: ContainerRow,
    attachments: readonly InstanceSpecAttachmentInput[],
  ): Promise<DesiredInstanceSpec> {
    const base = buildDesiredInstanceSpec({
      container: {
        id: row.id,
        serverId: row.server_id,
        generation: row.generation,
        imageFingerprint: row.image_fingerprint,
        cpuMillis: row.cpu_millis,
        memBytes: row.mem_bytes,
        nesting: row.nesting,
        syscallIntercept: row.syscall_intercept,
        rootPool: row.root_pool_name,
        rootSizeBytes: row.root_size_bytes,
        routedIp: row.routed_ip ?? '',
      },
      server: {
        id: row.server_id,
        parentInterface: row.parent_interface ?? '',
      },
      attachments,
    });
    const bag = asJsonObject(row.extensions);
    const contributions = [];
    for (const ext of this.extensions?.all() ?? []) {
      const enabled = this.extensionClaims
        ? await this.extensionClaims.isEnabled(row.server_id, ext.id)
        : false;
      if (!enabled) continue;
      if (bag[ext.id] !== undefined && (typeof bag[ext.id] !== 'object' || bag[ext.id] === null)) {
        this.logger.warn(`Ignoring unknown extension state shape for ${ext.id} on ${row.id}`);
        continue;
      }
      try {
        contributions.push(ext.contributeInstanceSpec({
          containerId: row.id,
          serverId: row.server_id,
          state: bag[ext.id],
        }));
      } catch (error) {
        if (isPackageHttpError(error)) throw error;
        throw error;
      }
    }
    for (const key of Object.keys(bag)) {
      if (!this.extensions?.get(key)) {
        this.logger.warn(`Ignoring unknown extension key ${key} on container ${row.id}`);
      }
    }
    return mergeInstanceSpecContributions(base, contributions);
  }

  supports(intent: IntentRecord): boolean {
    return intent.resourceType === 'container';
  }

  async reconcile(context: ReconcileRunContext): Promise<ReconcileOutcome> {
    if (!context.client) {
      throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'missing_client' });
    }
    const row = await this.readContainer(context.intent.resourceId);
    if (!row) {
      return {
        outcome: 'failed',
        failure: failure('CONTAINER_NOT_FOUND', 'The desired container no longer exists'),
      };
    }
    if (row.server_id !== context.intent.serverId) {
      return {
        outcome: 'failed',
        failure: failure('CONTAINER_SERVER_MISMATCH', 'The intent server does not own the container'),
      };
    }
    if (context.intent.targetGeneration < row.generation) {
      return {
        outcome: 'succeeded',
        observedGeneration: context.intent.targetGeneration,
      };
    }
    if (!row.parent_interface || !row.routed_ip || !row.network_key || !row.gateway) {
      return {
        outcome: 'failed',
        failure: failure(
          'MISSING_MANAGED_NETWORK_ADDRESS',
          'The container has no LAN bridge / claim / gateway',
        ),
      };
    }
    const prefixLength = parseCidrPrefix(row.network_key);
    if (prefixLength === undefined) {
      return {
        outcome: 'failed',
        failure: failure(
          'MISSING_MANAGED_NETWORK_ADDRESS',
          'The container network claim CIDR is invalid',
        ),
      };
    }
    const shouldDelete =
      row.lifecycle_phase === 'deleting'
      || context.intent.kind === 'container.delete';
    let desiredAttachments: ContainerAttachment[] = [];
    if (!shouldDelete) {
      const beforeMkdir = await this.rereadDesired(
        row.id,
        row.server_id,
        context.intent.targetGeneration,
      );
      if (beforeMkdir.stale) {
        return {
          outcome: 'succeeded',
          observedGeneration: context.intent.targetGeneration,
        };
      }
      const catalogOutcome = await this.ensureDesiredCatalogs(
        context,
        beforeMkdir.desired,
        row.server_id,
      );
      if (catalogOutcome) return catalogOutcome;
      const beforePut = await this.rereadDesired(
        row.id,
        row.server_id,
        context.intent.targetGeneration,
      );
      desiredAttachments = beforePut.desired;
    }
    let desired: DesiredInstanceSpec;
    try {
      desired = await this.desiredSpec(
        row,
        desiredAttachments.map<InstanceSpecAttachmentInput>((attachment) => ({
          id: attachment.id,
          containerPath: attachment.container_path,
          readOnly: attachment.read_only,
          volume: {
            id: attachment.volume_id,
            incusName: attachment.incus_name,
            poolName: attachment.pool_name,
          },
        })),
      );
    } catch (error) {
      if (isPackageHttpError(error)) {
        return {
          outcome: 'failed',
          failure: failure(error.code, error.message, error.details),
        };
      }
      throw error;
    }
    const expectedName = deriveInstanceName(row.id);
    let actual = await this.findExpectedOrIdentity(context.client, expectedName, row);
    if (shouldDelete) {
      const deleted = await this.deleteDesiredInstance(context.client, actual, row, context.intent);
      if (!deleted && actual) {
        return {
          outcome: 'failed',
          failure: failure(
            'INSTANCE_DELETE_IDENTITY_MISMATCH',
            'The managed instance could not be safely deleted due to its identity',
          ),
        };
      }
      await this.verifyAbsent(context.client, expectedName);
      await this.releaseContainerState(row);
      return { outcome: 'succeeded', observedGeneration: row.generation };
    }

    if (!actual) {
      await this.deleteManagedOrphans(context.client, row, context.intent);
      await this.createInstance(context.client, desired, expectedName, row, context.intent);
      actual = await this.readRequired(context.client, expectedName);
    } else if (actual.name !== expectedName) {
      await this.renameInstance(context.client, actual, expectedName);
      actual = await this.readRequired(context.client, expectedName);
    }

    let actualIdentity = managedContainerIdentity(actual.document);
    if (!actualIdentity.managed) {
      return {
        outcome: 'failed',
        failure: failure(
          'UNMANAGED_INSTANCE_NAME_COLLISION',
          `Incus instance ${expectedName} is not managed by nyabase`,
        ),
      };
    }
    if (
      actualIdentity.containerId !== normalized(row.id)
      || actualIdentity.serverId !== normalized(row.server_id)
    ) {
      this.logger.warn(
        `Refusing to modify instance ${actual.name} with identity `
        + `${actualIdentity.containerId}/${actualIdentity.serverId}`,
      );
      return {
        outcome: 'failed',
        failure: failure(
          'MANAGED_INSTANCE_IDENTITY_MISMATCH',
          'The managed instance identity does not match the desired container',
          {
            actualContainerId: actualIdentity.containerId,
            actualServerId: actualIdentity.serverId,
          },
        ),
      };
    }

    const state = await this.readState(context.client, expectedName, actual.document.state);
    const diff = compareManagedFields(actual.document, desired, this.ownership());
    if (diff.kind === 'managed_failure') {
      return {
        outcome: 'failed',
        failure: diff.error
          ? {
            code: diff.error.code,
            message: diff.error.error.message,
            details: diff.error.details as Record<string, unknown>,
          }
          : failure('MANAGED_COMPARATOR_FAILURE', 'Managed field comparison failed'),
      };
    }
    const actualRoot = bytes((actual.document.devices?.root as Record<string, unknown> | undefined)?.size);
    const desiredRoot = bytes((desired.devices?.root as Record<string, unknown> | undefined)?.size);
    const usedBytes = await this.observeRootUsage(
      context.client,
      row.root_pool_name,
      expectedName,
      state,
    );
    if (actualRoot !== null && desiredRoot !== null) {
      const decision = decideRootShrink({
        resizeFamily: row.root_resize_family,
        actualRootBytes: actualRoot,
        desiredRootBytes: desiredRoot,
        usedBytes,
        running: running(state),
      });
      if (decision !== 'allow') {
        const code = decision === 'requires_stop'
          ? 'ROOT_SHRINK_REQUIRES_STOP'
          : decision === 'usage_unknown'
            ? 'ROOT_USAGE_UNKNOWN'
            : 'ROOT_SHRINK_BELOW_USAGE';
        if (decision === 'usage_floor' || decision === 'usage_unknown') {
          await this.revertImpossibleRootShrink(row.id, actualRoot, usedBytes, code);
        }
        throw new IncusError(code, 'managed_failure', {
          containerId: row.id,
          requestedBytes: desiredRoot.toString(),
          usedBytes: usedBytes?.toString() ?? null,
        });
      }
    }
    if (!diff.empty) {
      if (running(state) && this.extensions?.requiresStop(diff)) {
        return {
          outcome: 'failed',
          failure: failure(
            FailureCode.ExtensionMutationRequiresStop,
            'Extension assignment changes require a stopped instance',
          ),
        };
      }
      await auditIncusMutate(this.audit, context.intent, {
        method: 'PUT',
        path: `/1.0/instances/${expectedName}`,
        instanceName: expectedName,
      });
      const client = context.client;
      if (!client) {
        throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'missing_client' });
      }
      try {
        await readAfterTimeout(
          () => requestAndWait(
            client,
            (options) => client.readModifyWriteInstance(
              expectedName,
              (document) => {
                const merged = applyManagedFields(
                  document as ManagedInstanceDocument,
                  desired,
                  this.ownership(),
                );
                document.config = merged.config;
                document.devices = merged.devices;
                return document;
              },
              options,
            ),
          ),
          async () => {
            const after = await this.readRequired(client, expectedName);
            const afterDiff = compareManagedFields(
              after.document,
              desired,
              this.ownership(),
            );
            if (afterDiff.kind !== 'empty') {
              throw new Error('INSTANCE_UPDATE_NOT_CONFIRMED');
            }
            return undefined;
          },
        );
      } catch (error) {
        if (isMissingCustomVolumeError(error) && desiredAttachments.length > 0) {
          throw new IncusError('VOLUME_PLACEMENT_PENDING', 'retry', {
            reason: 'put_toctou',
          });
        }
        throw error;
      }
    }

    await this.reconcilePower(context, row, expectedName, state);
    await this.reconcileRestart(context, row, expectedName, state);
    const sshState = await this.readState(context.client, expectedName, actual.document.state);
    if (running(sshState)) {
      await auditIncusMutate(this.audit, context.intent, {
        method: 'POST',
        path: `/1.0/instances/${expectedName}/exec`,
        instanceName: expectedName,
      });
      await applyGuestNetwork(
        context.client,
        expectedName,
        {
          address: row.routed_ip,
          prefixLength,
          gateway: row.gateway,
          dnsServers: row.dns_servers,
        },
        context.signal,
      );
    }
    const ssh = await this.reconcileSshFile(
      context.client,
      row,
      expectedName,
      sshState,
      context.signal,
    );
    const verified = await this.readRequired(context.client, expectedName);
    const verifiedState = await this.readState(context.client, expectedName, verified.document.state);
    const verificationDiff = compareManagedFields(
      verified.document,
      desired,
      this.ownership(),
    );
    if (verificationDiff.kind !== 'empty') {
      return {
        outcome: 'failed',
        failure: failure(
          'INSTANCE_VERIFY_FAILED',
          'The instance did not match the managed specification after reconciliation',
          {
            config: verificationDiff.config,
            devices: verificationDiff.devices,
          },
        ),
      };
    }
    const quota = observeRootQuotaPending(verified.document, row.root_size_bytes);
    const observedUsage = await this.observeRootUsage(
      context.client,
      row.root_pool_name,
      expectedName,
      verifiedState,
    );
    await this.persistObservation(
      row,
      verified.document,
      verifiedState,
      quota.pending,
      ssh,
      observedUsage,
    );
    if (quota.pending) {
      return {
        outcome: 'retry',
        failure: failure(
          'ROOT_QUOTA_PENDING',
          'Incus has not finished applying the root filesystem quota',
          { pendingSizeBytes: quota.pendingSizeBytes ?? row.root_size_bytes },
        ),
        retryAfterMs: 5_000,
      };
    }
    if (
      running(verifiedState)
      && row.ssh_public_key
      && ssh.status !== 'running'
      && ssh.status !== 'disabled'
      && ssh.status !== 'container_stopped'
    ) {
      return {
        outcome: 'retry',
        failure: failure(
          'SSH_DAEMON_PENDING',
          'SSH key is applied but the daemon is not accepting connections yet',
          { sshStatus: ssh.status, lastError: ssh.lastError ?? '' },
        ),
        retryAfterMs: 2_000,
      };
    }
    await this.settleVolumeBinds(row.id, expectedName, verified.document);
    return { outcome: 'succeeded', observedGeneration: row.generation };
  }

  async scan(serverId: string, client: IncusClientPort, signal: AbortSignal): Promise<void> {
    const rows = await this.database
      .selectFrom('control.containers')
      .select([
        'id',
        'generation',
        'server_id',
        'lifecycle_phase',
        'needs_attention',
        'power_intent',
      ])
      .where('server_id', '=', serverId)
      .execute();
    const known = new Set(
      rows
        .filter((row) => row.lifecycle_phase !== 'deleting')
        .map((row) => normalized(row.id)),
    );
    const instances = await client.listInstances(2, { signal });
    const documents = instances.metadata as InstanceFull[];
    const byContainerId = new Map<string, ActualInstance>();
    for (const document of documents) {
      const identity = managedContainerIdentity(document);
      if (
        identity.managed
        && identity.serverId === normalized(serverId)
        && identity.containerId
      ) {
        byContainerId.set(identity.containerId, {
          name: document.name ?? '',
          document,
        });
      }
    }
    if (this.intents) {
      for (const desired of rows) {
        if (desired.needs_attention || desired.lifecycle_phase === 'failed') continue;
        if (desired.lifecycle_phase === 'deleting') {
          await this.enqueueScanIntent(desired, 'container.delete');
          continue;
        }
        const expectedName = deriveInstanceName(desired.id);
        const actual = byContainerId.get(normalized(desired.id));
        const usage = bytes(actual?.document.state?.disk?.root?.usage);
        if (usage !== null) {
          await this.database
            .updateTable('control.containers')
            .set({ root_used_bytes: usage.toString() })
            .where('id', '=', desired.id)
            .where('lifecycle_phase', '!=', 'deleting')
            .execute();
        }
        if (await this.scanNeedsUpdate(desired, expectedName, actual)) {
          await this.enqueueScanIntent(desired, 'container.update');
        }
      }
    }
    for (const document of documents) {
      const instanceIdentity = managedContainerIdentity(document);
      if (
        !instanceIdentity.managed
        || instanceIdentity.serverId !== normalized(serverId)
        || known.has(instanceIdentity.containerId)
      ) {
        continue;
      }
      await this.deletePhysicalInstance(client, document.name ?? '', document);
    }
  }

  private async enqueueScanIntent(
    desired: {
      readonly id: string;
      readonly generation: number;
      readonly server_id: string;
    },
    kind: 'container.delete' | 'container.update',
  ): Promise<void> {
    if (!this.intents) return;
    await this.intents.ensurePending({
      kind,
      resourceType: 'container',
      resourceId: desired.id,
      serverId: desired.server_id,
      targetGeneration: desired.generation,
      reuseSettled: false,
      request: { source: 'full_scan', idempotencyKey: 'physical:scan' },
    });
  }

  private async scanNeedsUpdate(
    row: {
      readonly id: string;
      readonly server_id: string;
      readonly power_intent: 'running' | 'stopped';
    },
    expectedName: string,
    actual: ActualInstance | undefined,
  ): Promise<boolean> {
    if (!actual) return true;
    if (actual.name !== expectedName) return true;
    const status = actual.document.state?.status ?? actual.document.status;
    if (powerTransition(status, row.power_intent) !== 'none') return true;
    const full = await this.readContainer(row.id);
    if (!full?.parent_interface || !full.routed_ip || !full.network_key || !full.gateway) {
      return true;
    }
    const attachments = await this.readAttachments(row.id, row.server_id);
    const desired = await this.desiredSpec(
      full,
      attachments
        .filter((attachment) => attachment.bind_state !== 'detaching')
        .map<InstanceSpecAttachmentInput>((attachment) => ({
        id: attachment.id,
        containerPath: attachment.container_path,
        readOnly: attachment.read_only,
        volume: {
          id: attachment.volume_id,
          incusName: attachment.incus_name,
          poolName: attachment.pool_name,
        },
      })),
    );
    return compareManagedFields(
      actual.document,
      desired,
      this.ownership(),
    ).kind !== 'empty';
  }

  private async readContainer(id: string): Promise<ContainerRow | undefined> {
    const row = await this.database
      .selectFrom('control.containers as c')
      .innerJoin('infra.servers as s', 's.id', 'c.server_id')
      .innerJoin('infra.storage_pools as p', 'p.id', 'c.root_pool_id')
      .innerJoin('infra.images as i', 'i.id', 'c.image_id')
      .select([
        'c.id as id',
        'c.server_id as server_id',
        'c.owner_id as owner_id',
        'c.image_id as image_id',
        'c.generation as generation',
        'c.image_fingerprint as image_fingerprint',
        'c.root_size_bytes as root_size_bytes',
        'c.cpu_millis as cpu_millis',
        'c.mem_bytes as mem_bytes',
        'c.extensions as extensions',
        'c.nesting as nesting',
        'c.syscall_intercept as syscall_intercept',
        'c.power_intent as power_intent',
        'c.lifecycle_phase as lifecycle_phase',
        'p.incus_name as root_pool_name',
        'p.resize_family as root_resize_family',
        's.parent_interface as parent_interface',
        's.dns_servers as dns_servers',
        'i.login_user as login_user',
      ])
      .select((expression) => expression
        .selectFrom('iam.ssh_public_keys as user_keys')
        .select(sql<string | null>`
          string_agg(user_keys.key_text, E'\n' order by user_keys.created_at asc, user_keys.id asc)
        `.as('keys'))
        .whereRef('user_keys.user_id', '=', 'c.owner_id')
        .as('user_ssh_public_keys'))
      .select((expression) => expression
        .selectFrom('control.container_network_claims as n')
        .select('n.address')
        .whereRef('n.container_id', '=', 'c.id')
        .whereRef('n.server_id', '=', 'c.server_id')
        .where('n.state', '=', 'active')
        .orderBy('n.id')
        .limit(1)
        .as('routed_ip'))
      .select(sql<string | null>`(
          SELECT n.network_key::text
          FROM control.container_network_claims AS n
          WHERE n.container_id = c.id
            AND n.server_id = c.server_id
            AND n.state = 'active'
          ORDER BY n.id
          LIMIT 1
        )`.as('network_key'))
      .select(sql<string | null>`(
          SELECT host(pool.gateway)
          FROM control.container_network_claims AS n
          INNER JOIN infra.ip_pools AS pool ON pool.cidr = n.network_key
          WHERE n.container_id = c.id
            AND n.server_id = c.server_id
            AND n.state = 'active'
          ORDER BY n.id
          LIMIT 1
        )`.as('gateway'))
      .where('c.id', '=', id)
      .executeTakeFirst();
    return row
      ? {
        ...row,
        root_size_bytes: String(row.root_size_bytes),
        mem_bytes: String(row.mem_bytes),
        routed_ip: row.routed_ip ?? null,
        network_key: row.network_key ?? null,
        gateway: row.gateway ?? null,
        dns_servers: Array.isArray(row.dns_servers)
          ? row.dns_servers.filter((entry): entry is string => typeof entry === 'string')
          : [],
        parent_interface: row.parent_interface ?? null,
        ssh_public_key: composeAuthorizedKeys(row.user_ssh_public_keys),
      }
      : undefined;
  }

  private async settleVolumeBinds(
    containerId: string,
    instanceName: string,
    document: InstanceFull,
  ): Promise<void> {
    const devices = document.devices ?? {};
    const rows = await this.database
      .selectFrom('control.volume_attachments')
      .select(['id', 'bind_state', 'device_name'])
      .where('container_id', '=', containerId)
      .execute();
    for (const row of rows) {
      const present = Object.prototype.hasOwnProperty.call(devices, row.device_name);
      if (row.bind_state === 'attaching' && present) {
        await this.database
          .updateTable('control.volume_attachments')
          .set({ bind_state: 'attached' })
          .where('id', '=', row.id)
          .where('bind_state', '=', 'attaching')
          .execute();
      } else if (row.bind_state === 'detaching' && !present) {
        await this.database
          .deleteFrom('control.volume_attachments')
          .where('id', '=', row.id)
          .where('bind_state', '=', 'detaching')
          .execute();
      }
    }
    void instanceName;
  }

  private async rereadDesired(
    containerId: string,
    serverId: string,
    targetGeneration: number,
  ): Promise<{ stale: boolean; desired: ContainerAttachment[] }> {
    const current = await this.database
      .selectFrom('control.containers')
      .select('generation')
      .where('id', '=', containerId)
      .executeTakeFirst();
    const attachments = await this.readAttachments(containerId, serverId);
    const desired = attachments.filter((attachment) => attachment.bind_state !== 'detaching');
    return {
      stale: (current?.generation ?? targetGeneration) > targetGeneration,
      desired,
    };
  }

  private async ensureDesiredCatalogs(
    context: ReconcileRunContext,
    attachments: readonly ContainerAttachment[],
    serverId: string,
  ): Promise<ReconcileOutcome | undefined> {
    if (!context.client) {
      throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'missing_client' });
    }
    for (const attachment of attachments) {
      if (!attachment.pool_name) {
        throw new IncusError(
          attachment.shared ? 'VOLUME_PLACEMENT_PENDING' : 'MISSING_STORAGE_POOL',
          attachment.shared ? 'retry' : 'managed_failure',
          { volumeId: attachment.volume_id, serverId },
        );
      }
      if (attachment.shared) {
        const result = await ensureSharedCatalogOnServer(context.client, {
          poolName: attachment.pool_name,
          incusName: attachment.incus_name,
          sizeBytes: attachment.size_bytes,
        });
        if (result === 'missing') {
          if (context.intent.attemptCount >= VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS) {
            return {
              outcome: 'failed',
              failure: failure(
                'VOLUME_CATALOG_ADOPT_FAILED',
                'Incus did not adopt the existing CephFS directory into this daemon catalog',
                { volumeId: attachment.volume_id, serverId },
              ),
            };
          }
          throw new IncusError('VOLUME_CATALOG_ADOPT_PENDING', 'retry', {
            volumeId: attachment.volume_id,
            serverId,
          });
        }
        await this.markCatalogPresent(attachment.volume_id, serverId);
        this.logger.log(
          `container=${context.intent.resourceId} ensure shared catalog volume=${attachment.volume_id} `
          + `server=${serverId} result=${result}`,
        );
        continue;
      }
      try {
        await context.client.getStorageVolume(attachment.pool_name, 'custom', attachment.incus_name);
        await this.markCatalogPresent(attachment.volume_id, serverId);
      } catch (error) {
        if (error instanceof IncusError && error.code === 'MISSING_STORAGE_POOL') {
          throw error;
        }
        if (isNotFound(error) || isMissingCustomVolumeError(error)) {
          this.logger.log(
            `Custom volume ${attachment.incus_name} is not present on ${serverId}`,
          );
          throw new IncusError('VOLUME_PLACEMENT_PENDING', 'retry', {
            volumeId: attachment.volume_id,
            reason: 'preflight',
          });
        }
        throw error;
      }
    }
  }

  private async markCatalogPresent(volumeId: string, serverId: string): Promise<void> {
    await this.database
      .updateTable('control.volume_placements')
      .set({ catalog_state: 'present' })
      .where('volume_id', '=', volumeId)
      .where('server_id', '=', serverId)
      .execute();
    await this.database
      .updateTable('control.volumes')
      .set({ dir_ensured: true })
      .where('id', '=', volumeId)
      .execute();
  }

  private async readAttachments(
    containerId: string,
    serverId: string,
  ): Promise<ContainerAttachment[]> {
    const rows = await this.database
      .selectFrom('control.volume_attachments as a')
      .innerJoin('control.volumes as v', 'v.id', 'a.volume_id')
      .leftJoin('control.volume_placements as pl', (join) => join
        .onRef('pl.volume_id', '=', 'a.volume_id')
        .on('pl.server_id', '=', serverId))
      .leftJoin('infra.storage_pools as pp', 'pp.id', 'pl.pool_id')
      .select([
        'a.id as id',
        'a.container_path as container_path',
        'a.read_only as read_only',
        'a.bind_state as bind_state',
        'a.volume_id as volume_id',
        'v.incus_name as incus_name',
        'v.size_bytes as size_bytes',
        'v.pool_id as volume_pool_id',
        'v.server_id as volume_server_id',
        'v.shared_backend_id as shared_backend_id',
        'pl.pool_id as placement_pool_id',
        'pp.incus_name as placement_pool_name',
      ])
      .where('a.container_id', '=', containerId)
      .orderBy('a.id')
      .execute();
    const result: ContainerAttachment[] = [];
    for (const row of rows) {
      const shared = row.shared_backend_id !== null;
      if (row.bind_state === 'detaching') {
        result.push({
          id: row.id,
          container_path: row.container_path,
          read_only: row.read_only,
          volume_id: row.volume_id,
          incus_name: row.incus_name,
          pool_name: '',
          size_bytes: String(row.size_bytes),
          shared,
          bind_state: row.bind_state ?? 'attached',
        });
        continue;
      }
      let poolName: string | undefined;
      if (shared) {
        if (!row.placement_pool_id || !row.placement_pool_name) {
          throw new IncusError('VOLUME_PLACEMENT_PENDING', 'retry', {
            volumeId: row.volume_id,
            serverId,
          });
        }
        poolName = row.placement_pool_name;
      } else {
        const pool = await this.database
          .selectFrom('infra.storage_pools')
          .select('incus_name')
          .where('id', '=', row.volume_pool_id)
          .where('server_id', '=', serverId)
          .where('registered', '=', true)
          .executeTakeFirst();
        if (!pool) {
          throw new IncusError('MISSING_STORAGE_POOL', 'managed_failure', {
            volumeId: row.volume_id,
            serverId,
          });
        }
        poolName = pool.incus_name;
      }
      result.push({
        id: row.id,
        container_path: row.container_path,
        read_only: row.read_only,
        volume_id: row.volume_id,
        incus_name: row.incus_name,
        pool_name: poolName,
        size_bytes: String(row.size_bytes),
        shared,
        bind_state: row.bind_state ?? 'attached',
      });
    }
    return result;
  }

  private async findExpectedOrIdentity(
    client: IncusClientPort,
    expectedName: string,
    row: ContainerRow,
  ): Promise<ActualInstance | undefined> {
    try {
      return { name: expectedName, document: (await client.getInstanceFull(expectedName)).metadata };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const listed = await client.listInstances(2);
    for (const item of listed.metadata as InstanceFull[]) {
      const itemIdentity = managedContainerIdentity(item);
      if (
        itemIdentity.managed
        && itemIdentity.containerId === normalized(row.id)
        && itemIdentity.serverId === normalized(row.server_id)
      ) {
        return { name: item.name ?? expectedName, document: item };
      }
      if (
        itemIdentity.managed
        && itemIdentity.containerId === normalized(row.id)
        && itemIdentity.serverId !== normalized(row.server_id)
      ) {
        this.logger.warn(
          `Found container ${row.id} on a different server; refusing cross-server deletion`,
        );
        return { name: item.name ?? expectedName, document: item };
      }
    }
    return undefined;
  }

  private async createInstance(
    client: IncusClientPort,
    desired: DesiredInstanceSpec,
    expectedName: string,
    row: ContainerRow,
    intent: IntentRecord,
  ): Promise<void> {
    await auditIncusMutate(this.audit, intent, {
      method: 'POST',
      path: '/1.0/instances',
      instanceName: expectedName,
    });
    const create = async (): Promise<void> => {
      try {
        await requestAndWait(
          client,
          (options) => client.createInstance({
            ...desired,
            name: expectedName,
            start: false,
          }, options),
        );
      } catch (error) {
        if (isMissingCustomVolumeError(error)) {
          throw new IncusError('VOLUME_PLACEMENT_PENDING', 'retry', {
            reason: 'create_missing_volume',
          });
        }
        throw error;
      }
    };
    await readAfterTimeout(
      create,
      async () => {
        try {
          await client.getInstanceFull(expectedName);
        } catch (error) {
          throw error;
        }
      },
    );
    await this.database
      .updateTable('control.containers')
      .set({ instance_name: expectedName })
      .where('id', '=', row.id)
      .execute();
  }

  private async renameInstance(
    client: IncusClientPort,
    actual: ActualInstance,
    expectedName: string,
  ): Promise<void> {
    if (actual.name === expectedName) return;
    await readAfterTimeout(
      () => requestAndWait(
        client,
        (options) => client.renameInstance(actual.name, { name: expectedName }, options),
      ),
      async () => {
        await client.getInstanceFull(expectedName);
        return undefined;
      },
    );
  }

  private async deleteDesiredInstance(
    client: IncusClientPort,
    actual: ActualInstance | undefined,
    row: ContainerRow,
    intent: IntentRecord,
  ): Promise<boolean> {
    if (!actual) return false;
    const actualIdentity = managedContainerIdentity(actual.document);
    if (!actualIdentity.managed) return false;
    if (actualIdentity.serverId !== normalized(row.server_id)) {
      this.logger.warn(`Refusing to delete cross-server instance ${actual.name}`);
      return false;
    }
    await this.deletePhysicalInstance(client, actual.name, actual.document, intent);
    return true;
  }

  private async deleteManagedOrphans(
    client: IncusClientPort,
    row: ContainerRow,
    intent: IntentRecord,
  ): Promise<void> {
    const knownRows = await this.database
      .selectFrom('control.containers')
      .select('id')
      .where('server_id', '=', row.server_id)
      .where('lifecycle_phase', '!=', 'deleting')
      .execute();
    const known = new Set(knownRows.map((item) => normalized(item.id)));
    const instances = await client.listInstances(2);
    for (const document of instances.metadata as InstanceFull[]) {
      const itemIdentity = managedContainerIdentity(document);
      if (
        itemIdentity.managed
        && itemIdentity.serverId === normalized(row.server_id)
        && !known.has(itemIdentity.containerId)
        && document.name
      ) {
        await this.deletePhysicalInstance(client, document.name, document, intent);
      }
    }
  }

  private async deletePhysicalInstance(
    client: IncusClientPort,
    name: string,
    document: InstanceFull,
    intent?: IntentRecord,
  ): Promise<void> {
    if (!name) return;
    if (intent) {
      await auditIncusMutate(this.audit, intent, {
        method: 'DELETE',
        path: `/1.0/instances/${name}`,
        instanceName: name,
      });
    }
    const state = await this.readState(client, name, document.state);
    if (running(state)) {
      await readAfterTimeout(
        () => requestAndWait(
          client,
          (options) => client.updateInstanceState(name, { action: 'stop', force: true }, options),
        ),
        async () => {
          const after = await client.getInstanceState(name);
          if (!running(after.metadata)) return undefined;
          throw new Error('INSTANCE_STOP_NOT_CONFIRMED');
        },
      );
    }
    await readAfterTimeout(
      () => requestAndWait(client, (options) => client.deleteInstance(name, options)),
      async () => {
        try {
          await client.getInstanceFull(name);
        } catch (error) {
          if (isNotFound(error)) return undefined;
          throw error;
        }
        throw new Error('INSTANCE_DELETE_NOT_CONFIRMED');
      },
    );
    await this.verifyAbsent(client, name);
  }

  private async verifyAbsent(client: IncusClientPort, name: string): Promise<void> {
    try {
      await client.getInstanceFull(name);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
      reason: 'instance_still_present',
      name,
    });
  }

  private async releaseContainerState(row: ContainerRow): Promise<void> {
    await this.database
      .updateTable('control.container_network_claims')
      .set({
        container_id: null,
        state: 'releasing',
        reusable_at: sql<Date>`clock_timestamp() + interval '360 seconds'`,
        owner_kind: 'runtime_cleanup',
        cleanup_payload_json: JSON.stringify({
          resourceType: 'container',
          resourceId: row.id,
          serverId: row.server_id,
        }),
      })
      .where('container_id', '=', row.id)
      .execute();
    await this.database
      .deleteFrom('control.containers')
      .where('id', '=', row.id)
      .execute();
  }

  private async readRequired(client: IncusClientPort, name: string): Promise<ActualInstance> {
    return { name, document: (await client.getInstanceFull(name)).metadata };
  }

  private async readState(
    client: IncusClientPort,
    name: string,
    _documentState?: InstanceState,
  ): Promise<InstanceState> {
    // Always refresh from /state. InstanceFull.state can lag behind power transitions
    // (create starts stopped; reconcilePower then starts), and reusing it marks SSH as
    // container_stopped while the instance is already Running.
    return (await client.getInstanceState(name)).metadata;
  }

  private async observeRootUsage(
    client: IncusClientPort | undefined,
    poolName: string,
    instanceName: string,
    state: InstanceState,
  ): Promise<bigint | null> {
    const fromState = bytes(state.disk?.root?.usage);
    if (fromState !== null && fromState > 0n) return fromState;
    if (!client) return fromState;
    try {
      const volumeState = await client.getStorageVolumeState(poolName, 'container', instanceName);
      const fromVolume = bytes(volumeState.metadata.usage?.used);
      if (fromVolume !== null && fromVolume > 0n) return fromVolume;
    } catch {
      // Best-effort: missing instance-volume usage still blocks quota-online shrink.
    }
    return fromState;
  }

  private async revertImpossibleRootShrink(
    containerId: string,
    actualRootBytes: bigint,
    usedBytes: bigint | null,
    failureCode: string,
  ): Promise<void> {
    await this.database
      .updateTable('control.containers')
      .set({
        root_size_bytes: actualRootBytes.toString(),
        ...(usedBytes === null ? {} : { root_used_bytes: usedBytes.toString() }),
        needs_attention: true,
        failure_code: failureCode.slice(0, 128),
      })
      .where('id', '=', containerId)
      .where('lifecycle_phase', 'not in', ['deleting', 'failed'])
      .execute();
  }

  private async reconcilePower(
    context: ReconcileRunContext,
    row: ContainerRow,
    name: string,
    currentState: InstanceState,
  ): Promise<void> {
    if (context.intent.kind === 'container.power' && context.intent.request?.action === 'restart') {
      return;
    }
    const transition = powerTransition(currentState.status, row.power_intent);
    if (transition === 'none') return;
    await readAfterTimeout(
      () => requestAndWait(
        context.client!,
        (options) => context.client!.updateInstanceState(
          name,
          { action: transition, force: transition === 'stop' },
          options,
        ),
      ),
      async () => {
        const after = (await context.client!.getInstanceState(name)).metadata;
        const afterRunning = running(after);
        if ((transition === 'start' && afterRunning) || (transition === 'stop' && !afterRunning)) {
          return undefined;
        }
        throw new Error('INSTANCE_POWER_NOT_CONFIRMED');
      },
    );
  }

  private async reconcileRestart(
    context: ReconcileRunContext,
    _row: ContainerRow,
    name: string,
    currentState: InstanceState,
  ): Promise<void> {
    if (context.intent.kind !== 'container.power' || context.intent.request?.action !== 'restart') {
      return;
    }
    const baseline = context.intent.baseline;
    if (!baseline || !Object.prototype.hasOwnProperty.call(baseline, 'startedAt')) {
      throw new IncusError('RESTART_BASELINE_MISSING', 'managed_failure');
    }
    const baselineStartedAt = baseline.startedAt === null ? null : String(baseline.startedAt);
    const currentStartedAt = currentState.started_at ?? null;
    if (restartTransition(currentStartedAt, baselineStartedAt, currentState.status) === 'proven') {
      return;
    }
    await readAfterTimeout(
      () => requestAndWait(
        context.client!,
        (options) => context.client!.updateInstanceState(
          name,
          { action: 'restart', force: true },
          options,
        ),
      ),
      async () => {
        const after = (await context.client!.getInstanceState(name)).metadata;
        if (
          running(after)
          && after.started_at
          && after.started_at !== baselineStartedAt
        ) {
          return undefined;
        }
        throw new Error('INSTANCE_RESTART_NOT_CONFIRMED');
      },
    );
    const verified = await context.client!.getInstanceState(name);
    const nextStartedAt = verified.metadata.started_at ?? null;
    if (
      !running(verified.metadata)
      || nextStartedAt === null
      || nextStartedAt === baselineStartedAt
    ) {
      throw new IncusError('RESTART_PROOF_MISSING', 'managed_failure', {
        baselineStartedAt: baselineStartedAt ?? '',
        observedStartedAt: nextStartedAt ?? '',
      });
    }
  }

  private async reconcileSshFile(
    client: IncusClientPort,
    row: ContainerRow,
    name: string,
    state: InstanceState,
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
      : await this.sshState.readHomeDirectoryMetadata(
        client,
        name,
        `/home/${row.login_user}`,
        signal,
      );
    const desiredMetadata = sshFileMetadata(row.login_user, homeMetadata);
    let actual = await this.sshState.readAuthorizedKeys(client, name, path, signal);
    if (sshFileNeedsReconcile({
      actual,
      desiredContent: content,
      desiredMetadata,
    })) {
      try {
        await this.sshState.writeAuthorizedKeys(
          client,
          name,
          path,
          content,
          desiredMetadata,
          signal,
        );
      } catch (error) {
        if (!(error instanceof IncusError) || error.code !== 'INCUS_TIMEOUT') throw error;
        const afterTimeout = await this.sshState.readAuthorizedKeys(client, name, path, signal);
        if (sshFileNeedsReconcile({
          actual: afterTimeout,
          desiredContent: content,
          desiredMetadata,
        })) {
          throw error;
        }
      }
      actual = await this.sshState.readAuthorizedKeys(client, name, path, signal);
    }
    if (sshFileNeedsReconcile({
      actual,
      desiredContent: content,
      desiredMetadata,
    })) {
      throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
        reason: 'ssh_file_state_mismatch',
        path,
      });
    }

    if (!running(state)) {
      return { status: 'container_stopped', lastError: null };
    }
    const sshd = await this.sshState.probeSshd(client, name, signal);
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

  private async persistObservation(
    row: ContainerRow,
    actual: InstanceFull,
    state: InstanceState,
    quotaPending: boolean,
    ssh: SshFileObservation,
    usedBytes: bigint | null = bytes(state.disk?.root?.usage),
  ): Promise<void> {
    await this.database
      .updateTable('control.containers')
      .set({
        instance_name: actual.name ?? deriveInstanceName(row.id),
        observed_generation: row.generation,
        root_size_pending_bytes: quotaPending ? String(row.root_size_bytes) : null,
        failure_code: null,
        failure_reason: null,
        last_transition_at: sql<Date>`clock_timestamp()`,
        lifecycle_phase: row.lifecycle_phase === 'provisioning' ? 'active' : row.lifecycle_phase,
        ...(usedBytes === null ? {} : { root_used_bytes: usedBytes.toString() }),
      })
      .where('id', '=', row.id)
      .execute();
    await this.database
      .updateTable('control.container_ssh_routes')
      .set({
        instance_name: actual.name ?? deriveInstanceName(row.id),
        instance_status: state.status ?? 'unknown',
        instance_started_at: state.started_at ?? null,
        ssh_status: ssh.status,
        last_error: ssh.lastError,
        observed_at: sql<Date>`clock_timestamp()`,
      })
      .where('container_id', '=', row.id)
      .execute();
    try {
      await this.proxySnapshots?.notify('container-ssh-route-observed');
    } catch (error) {
      this.logger.warn(
        `SSH proxy snapshot notify failed after observing container ${row.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (state.status?.toLowerCase() === 'error') {
      this.logger.warn(`Container ${row.id} is in Incus error state`);
    }
  }
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

/** Build guest authorized_keys from platform user public keys only (T3 jump). */
export function composeAuthorizedKeys(
  userKeys: string | null | undefined,
): string | null {
  if (!userKeys) return null;
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const line of userKeys.split('\n')) {
    const key = line.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    lines.push(key);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}
