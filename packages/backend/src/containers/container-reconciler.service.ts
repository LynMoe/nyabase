import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FailureCode } from '@nyabase/common';
import type { Kysely } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { AuditService } from '../iam/audit.service.js';
import {
  compareManagedFields,
  deriveInstanceName,
  IncusError,
  observeRootQuotaPending,
  type DesiredInstanceSpec,
  type IncusClientPort,
} from '../incus/index.js';
import {
  IntentRepository,
  type IntentFailure,
  type IntentRecord,
  type PhysicalSettlement,
} from '../reconcile/intent.repository.js';
import type {
  ManagedReconciler,
  ReconcileOutcome,
  ReconcileRunContext,
  ResourceAuthority,
} from '../reconcile/managed-reconciler.js';
import { ReconcilerRegistry } from '../reconcile/reconciler-registry.service.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { gpuRequiresStop } from '../gpu/instance-spec.js';
import { applyGuestNetwork, parseCidrPrefix } from './guest-network.adapter.js';
import { IncusContainerSshStateAdapter } from './container-ssh-state.adapter.js';
import { settleContainerIntent } from './container-intents.js';
import { guardRootShrink, putManagedFields } from './container-apply.js';
import { buildContainerSpec, toSpecAttachments } from './container-desired-spec.js';
import {
  createInstance,
  deleteDesiredInstance,
  deleteManagedOrphans,
  findExpectedOrIdentity,
  observeRootUsage,
  readRequired,
  readState,
  renameInstance,
  verifyAbsent,
} from './container-instance-ops.js';
import { reconcilePower, reconcileRestart } from './container-power.js';
import type { ContainerReconcileDeps } from './container-reconcile-deps.js';
import { ContainerReconcileStore } from './container-reconcile.store.js';
import {
  MANAGED_FIELD_OWNERSHIP,
  auditIncusMutate,
  failure,
  managedContainerIdentity,
  normalized,
  running,
  type ActualInstance,
  type ContainerAttachment,
  type ContainerRow,
  type InstanceFull,
  type InstanceState,
  type SshFileObservation,
} from './container-reconcile-support.js';
import { scanServerContainers } from './container-scan.js';
import { reconcileSshFile } from './container-ssh-file.js';
import { ensureDesiredCatalogs } from './container-volume-catalogs.js';

type Loaded =
  | { readonly outcome: ReconcileOutcome }
  | { readonly row: ContainerRow; readonly prefixLength: number };

/**
 * Drives container intents against Incus: converge the instance (create,
 * rename, managed fields, power, guest network, SSH key) or delete it. The
 * steps live in the container-* modules; all SQL is in the store.
 */
@Injectable()
export class ContainerReconciler implements ManagedReconciler, OnModuleInit {
  readonly resourceType = 'container' as const;
  private readonly logger = new Logger(ContainerReconciler.name);
  private readonly store: ContainerReconcileStore;
  private readonly deps: ContainerReconcileDeps;

  constructor(
    @Inject(PG_DATABASE) database: Kysely<NyabaseDatabase>,
    private readonly intents: IntentRepository,
    sshState: IncusContainerSshStateAdapter,
    private readonly proxySnapshots: ProxySnapshotNotifierService,
    audit: AuditService,
    private readonly registry: ReconcilerRegistry,
  ) {
    this.store = new ContainerReconcileStore(database, intents);
    this.deps = { store: this.store, audit, logger: this.logger, sshState };
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  supports(intent: IntentRecord): boolean {
    return intent.resourceType === this.resourceType;
  }

  needsAttention(containerId: string): Promise<boolean> {
    return this.store.needsAttention(containerId);
  }

  markSucceeded(containerId: string, revision: number): Promise<void> {
    return this.store.markSucceeded(containerId, revision);
  }

  markFailure(containerId: string, failure: IntentFailure, attention: boolean): Promise<void> {
    return this.store.markFailure(containerId, failure, attention);
  }

  settle(
    intent: IntentRecord,
    observedRevision: number,
    settlement: PhysicalSettlement,
  ): Promise<void> {
    return settleContainerIntent(this.intents, intent, observedRevision, settlement);
  }

  resourceAuthorities(containerIds: readonly string[]): Promise<Map<string, ResourceAuthority>> {
    return this.store.resourceAuthorities(containerIds);
  }

  scan(serverId: string, client: IncusClientPort, signal: AbortSignal): Promise<void> {
    return scanServerContainers(this.deps, serverId, client, signal);
  }

  /** Load the desired container and refuse intents that cannot be applied to it. */
  private async load(context: ReconcileRunContext): Promise<Loaded> {
    const row = await this.store.readContainer(context.intent.resourceId);
    if (!row) {
      return {
        outcome: {
          outcome: 'failed',
          failure: failure('CONTAINER_NOT_FOUND', 'The desired container no longer exists'),
        },
      };
    }
    if (row.server_id !== context.intent.serverId) {
      return {
        outcome: {
          outcome: 'failed',
          failure: failure('CONTAINER_SERVER_MISMATCH', 'The intent server does not own the container'),
        },
      };
    }
    if (context.intent.targetRevision < row.revision) {
      return {
        outcome: { outcome: 'succeeded', observedRevision: context.intent.targetRevision },
      };
    }
    if (!row.parent_interface || !row.routed_ip || !row.network_key || !row.gateway) {
      return {
        outcome: {
          outcome: 'failed',
          failure: failure(
            'MISSING_MANAGED_NETWORK_ADDRESS',
            'The container has no LAN bridge / claim / gateway',
          ),
        },
      };
    }
    const prefixLength = parseCidrPrefix(row.network_key);
    if (prefixLength === undefined) {
      return {
        outcome: {
          outcome: 'failed',
          failure: failure(
            'MISSING_MANAGED_NETWORK_ADDRESS',
            'The container network claim CIDR is invalid',
          ),
        },
      };
    }
    return { row, prefixLength };
  }

  /**
   * The attachments the instance must carry, with their catalogs present on the
   * server. Undefined `attachments` means the intent became stale or an outcome
   * must be returned instead.
   */
  private async prepareAttachments(
    context: ReconcileRunContext,
    row: ContainerRow,
  ): Promise<{ outcome: ReconcileOutcome } | { attachments: ContainerAttachment[] }> {
    const beforeMkdir = await this.store.rereadDesired(
      row.id,
      row.server_id,
      context.intent.targetRevision,
    );
    if (beforeMkdir.stale) {
      return {
        outcome: { outcome: 'succeeded', observedRevision: context.intent.targetRevision },
      };
    }
    const catalogOutcome = await ensureDesiredCatalogs(
      this.deps,
      context,
      beforeMkdir.desired,
      row.server_id,
    );
    if (catalogOutcome) return { outcome: catalogOutcome };
    const beforePut = await this.store.rereadDesired(
      row.id,
      row.server_id,
      context.intent.targetRevision,
    );
    return { attachments: beforePut.desired };
  }

  private async reconcileDelete(
    context: ReconcileRunContext,
    client: IncusClientPort,
    row: ContainerRow,
    expectedName: string,
  ): Promise<ReconcileOutcome> {
    const actual = await findExpectedOrIdentity(this.deps, client, expectedName, row);
    const deleted = await deleteDesiredInstance(this.deps, client, actual, row, context.intent);
    if (!deleted && actual) {
      return {
        outcome: 'failed',
        failure: failure(
          'INSTANCE_DELETE_IDENTITY_MISMATCH',
          'The managed instance could not be safely deleted due to its identity',
        ),
      };
    }
    await verifyAbsent(client, expectedName);
    await this.store.releaseContainerState(row);
    return { outcome: 'succeeded', observedRevision: row.revision };
  }

  /** The instance under its expected name: created or renamed into place first. */
  private async ensureInstance(
    context: ReconcileRunContext,
    client: IncusClientPort,
    row: ContainerRow,
    desired: DesiredInstanceSpec,
    expectedName: string,
  ): Promise<ActualInstance> {
    const actual = await findExpectedOrIdentity(this.deps, client, expectedName, row);
    if (!actual) {
      await deleteManagedOrphans(this.deps, client, row, context.intent);
      await createInstance(this.deps, client, desired, expectedName, row, context.intent);
      return readRequired(client, expectedName);
    }
    if (actual.name !== expectedName) {
      await renameInstance(client, actual, expectedName);
      return readRequired(client, expectedName);
    }
    return actual;
  }

  /** Never touch an instance that is not ours or that belongs to another container/server. */
  private checkIdentity(
    actual: ActualInstance,
    row: ContainerRow,
    expectedName: string,
  ): ReconcileOutcome | null {
    const actualIdentity = managedContainerIdentity(actual.document);
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
    return null;
  }

  async reconcile(context: ReconcileRunContext): Promise<ReconcileOutcome> {
    const client = context.client;
    if (!client) {
      throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'missing_client' });
    }
    const loaded = await this.load(context);
    if ('outcome' in loaded) return loaded.outcome;
    const { row, prefixLength } = loaded;
    const expectedName = deriveInstanceName(row.id);
    if (row.lifecycle_phase === 'deleting' || context.intent.kind === 'container.delete') {
      return this.reconcileDelete(context, client, row, expectedName);
    }
    const prepared = await this.prepareAttachments(context, row);
    if ('outcome' in prepared) return prepared.outcome;
    const desiredAttachments = prepared.attachments;
    const desired = buildContainerSpec(row, toSpecAttachments(desiredAttachments));

    const actual = await this.ensureInstance(context, client, row, desired, expectedName);
    const identityOutcome = this.checkIdentity(actual, row, expectedName);
    if (identityOutcome) return identityOutcome;

    const state = await readState(client, expectedName);
    const diff = compareManagedFields(actual.document, desired, MANAGED_FIELD_OWNERSHIP);
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
    const usedBytes = await observeRootUsage(client, row.root_pool_name, expectedName, state);
    await guardRootShrink(this.deps, row, actual, desired, state, usedBytes);
    if (!diff.empty) {
      if (running(state) && gpuRequiresStop(diff)) {
        return {
          outcome: 'failed',
          failure: failure(
            FailureCode.GpuMutationRequiresStop,
            'GPU assignment changes require a stopped instance',
          ),
        };
      }
      await putManagedFields(this.deps, context, expectedName, desired, desiredAttachments.length > 0);
    }

    await reconcilePower(context, row, expectedName, state);
    await reconcileRestart(context, expectedName, state);
    const sshState = await readState(client, expectedName);
    if (running(sshState)) {
      await auditIncusMutate(this.deps.audit, context.intent, {
        method: 'POST',
        path: `/1.0/instances/${expectedName}/exec`,
        instanceName: expectedName,
      });
      await applyGuestNetwork(
        client,
        expectedName,
        {
          address: row.routed_ip!,
          prefixLength,
          gateway: row.gateway!,
          dnsServers: row.dns_servers,
        },
        context.signal,
      );
    }
    const ssh = await reconcileSshFile(
      this.deps.sshState,
      client,
      row,
      expectedName,
      sshState,
      context.signal,
    );
    return this.verifyAndSettle(context, client, row, desired, expectedName, ssh);
  }

  /** Re-read the instance, check it matches the spec, record the observation and pick the outcome. */
  private async verifyAndSettle(
    context: ReconcileRunContext,
    client: IncusClientPort,
    row: ContainerRow,
    desired: DesiredInstanceSpec,
    expectedName: string,
    ssh: SshFileObservation,
  ): Promise<ReconcileOutcome> {
    const verified = await readRequired(client, expectedName);
    const verifiedState = await readState(client, expectedName);
    const verificationDiff = compareManagedFields(
      verified.document,
      desired,
      MANAGED_FIELD_OWNERSHIP,
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
    const observedUsage = await observeRootUsage(
      client,
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
      // Image-owned sshd absence is durable; retrying will not install the binary.
      && ssh.lastError !== 'key_applied_sshd_missing'
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
    await this.store.settleVolumeBinds(row.id, verified.document);
    return { outcome: 'succeeded', observedRevision: row.revision };
  }

  private async persistObservation(
    row: ContainerRow,
    actual: InstanceFull,
    state: InstanceState,
    quotaPending: boolean,
    ssh: SshFileObservation,
    usedBytes: bigint | null,
  ): Promise<void> {
    await this.store.recordObservation(row, actual, state, quotaPending, ssh, usedBytes);
    try {
      await this.proxySnapshots.notify('container-ssh-route-observed');
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
