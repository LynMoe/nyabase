import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditAction, FailureCode } from '@nyabase/common';
import { AuditService } from '../iam/audit.service.js';
import { AccessChangeNotifier } from '../iam/access-resolver.service.js';
import { ReconcileWakeService } from '../reconcile/reconcile-wake.service.js';
import {
  compareManagedFields,
  deriveInstanceName,
  IncusError,
  isMissingCustomVolumeError,
  observeRootQuotaPending,
  type DesiredInstanceSpec,
  type IncusClientPort,
  type ManagedFieldsDiff,
} from '../incus/index.js';
import { CpuSetService } from '../cpu/cpu-sets.service.js';
import { resolveContainerRuntime, sameCpus } from './container-runtime.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import type {
  IntentFailure,
  IntentRecord,
  PhysicalSettlement,
} from '../reconcile/intent.repository.js';
import type {
  ManagedReconciler,
  ReconcileOutcome,
  ReconcileRunContext,
  ResourceAuthority,
} from '../reconcile/managed-reconciler.js';
import { intentFailure } from '../reconcile/intent-model.js';
import { failedOutcome } from '../reconcile/managed-reconciler.js';
import { ReconcilerRegistry } from '../reconcile/reconciler-registry.service.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { gpuRequiresStop } from '../gpu/instance-spec.js';
import {
  VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS,
  ensureSharedCatalogOnServer,
} from '../volumes/shared-volume-catalog.service.js';
import { applyGuestNetwork, parseCidrPrefix } from './guest-network.adapter.js';
import {
  buildContainerSpec,
  createInstance,
  deletePhysicalInstance,
  findExpectedOrIdentity,
  isNotFound,
  MANAGED_FIELD_OWNERSHIP,
  managedContainerIdentity,
  normalized,
  observedDiskUsageBytes,
  observeRootUsage,
  orphanInstances,
  powerTransition,
  putManagedFields,
  readRequired,
  readState,
  renameInstance,
  restartTransition,
  restartWithProof,
  running,
  setPowerState,
  toSpecAttachments,
  verifyAbsent,
  type ActualInstance,
  type InstanceFull,
  type InstanceState,
} from './container-instance-ops.js';
import {
  ContainerReconcileStore,
  type ContainerAttachment,
  type ContainerRow,
  type SshFileObservation,
} from './container-reconcile.store.js';
import { decideRootShrink } from './container-rules.js';
import { IncusContainerSshStateAdapter, reconcileSshFile } from './container-ssh.js';

type Loaded =
  | { readonly outcome: ReconcileOutcome }
  | { readonly row: ContainerRow; readonly prefixLength: number };

/**
 * Drives container intents against Incus: converge the instance (create,
 * rename, managed fields, power, guest network, SSH key) or delete it. The
 * steps are private methods; the Incus operations are plain functions in
 * container-instance-ops and all SQL is in the store.
 */
@Injectable()
export class ContainerReconciler implements ManagedReconciler, OnModuleInit {
  readonly resourceType = 'container' as const;
  private readonly logger = new Logger(ContainerReconciler.name);

  constructor(
    private readonly store: ContainerReconcileStore,
    private readonly sshState: IncusContainerSshStateAdapter,
    private readonly proxySnapshots: ProxySnapshotNotifierService,
    private readonly audit: AuditService,
    private readonly registry: ReconcilerRegistry,
    private readonly cpuSets: CpuSetService,
    private readonly config: NyabaseConfigService,
    private readonly accessChanges: AccessChangeNotifier,
    private readonly wake: ReconcileWakeService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    // A grant change can resize or move an owner's CPU set; re-pin without waiting for the next scan.
    this.accessChanges.onChange(() => this.wake.wake({ reason: 'scan' }));
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
    return this.store.settleIntent(intent, observedRevision, settlement);
  }

  resourceAuthorities(containerIds: readonly string[]): Promise<Map<string, ResourceAuthority>> {
    return this.store.resourceAuthorities(containerIds);
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
    const prepared = await this.prepareAttachments(context, client, row);
    if ('outcome' in prepared) return prepared.outcome;
    const desiredAttachments = prepared.attachments;
    const runtime = await resolveContainerRuntime(this.cpuSets, this.config, row);
    const desired = buildContainerSpec(row, toSpecAttachments(desiredAttachments), runtime);

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
          : intentFailure('MANAGED_COMPARATOR_FAILURE', 'Managed field comparison failed'),
      };
    }
    const usedBytes = await observeRootUsage(client, row.root_pool_name, expectedName, state);
    await this.guardRootShrink(row, actual, desired, state, usedBytes);
    if (!diff.empty) {
      if (running(state) && gpuRequiresStop(diff)) {
        return failedOutcome(
            FailureCode.GpuMutationRequiresStop,
            'GPU assignment changes require a stopped instance',
          );
      }
      await this.auditMutate(context.intent, 'PUT', `/1.0/instances/${expectedName}`, expectedName);
      if (context.intent.request?.source === 'full_scan') await this.auditDrift(context.intent, diff);
      await putManagedFields(client, expectedName, desired, desiredAttachments.length > 0);
    }

    await this.reconcilePower(context, client, row, expectedName, state);
    await this.reconcileRestart(context, client, expectedName, state);
    const sshState = await readState(client, expectedName);
    if (running(sshState)) {
      await this.auditMutate(
        context.intent,
        'POST',
        `/1.0/instances/${expectedName}/exec`,
        expectedName,
      );
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
      this.sshState,
      client,
      row,
      expectedName,
      running(sshState),
      context.signal,
    );
    const outcome = await this.verifyAndSettle(client, row, desired, expectedName, ssh);
    if (outcome.outcome === 'succeeded' && !sameCpus(row.cpu_set, runtime.cpus)) {
      await this.store.recordCpuSet(row.id, runtime.cpus);
    }
    return outcome;
  }

  // --- loading and preparation ---------------------------------------------------

  /** Load the desired container and refuse intents that cannot be applied to it. */
  private async load(context: ReconcileRunContext): Promise<Loaded> {
    const row = await this.store.readContainer(context.intent.resourceId);
    if (!row) {
      return {
        outcome: failedOutcome('CONTAINER_NOT_FOUND', 'The desired container no longer exists'),
      };
    }
    if (row.server_id !== context.intent.serverId) {
      return {
        outcome: failedOutcome('CONTAINER_SERVER_MISMATCH', 'The intent server does not own the container'),
      };
    }
    if (context.intent.targetRevision < row.revision) {
      return {
        outcome: { outcome: 'succeeded', observedRevision: context.intent.targetRevision },
      };
    }
    if (!row.parent_interface || !row.routed_ip || !row.network_key || !row.gateway) {
      return {
        outcome: failedOutcome(
            'MISSING_MANAGED_NETWORK_ADDRESS',
            'The container has no LAN bridge / claim / gateway',
          ),
      };
    }
    const prefixLength = parseCidrPrefix(row.network_key);
    if (prefixLength === undefined) {
      return {
        outcome: failedOutcome(
            'MISSING_MANAGED_NETWORK_ADDRESS',
            'The container network claim CIDR is invalid',
          ),
      };
    }
    return { row, prefixLength };
  }

  /**
   * The attachments the instance must carry, with their catalogs present on the
   * server. An outcome means the intent became stale or must end here.
   */
  private async prepareAttachments(
    context: ReconcileRunContext,
    client: IncusClientPort,
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
    const catalogOutcome = await this.ensureDesiredCatalogs(
      context,
      client,
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

  /**
   * Every volume the instance mounts must already exist in this daemon's Incus
   * catalog before the instance PUT, or Incus rejects the device.
   */
  private async ensureDesiredCatalogs(
    context: ReconcileRunContext,
    client: IncusClientPort,
    attachments: readonly ContainerAttachment[],
    serverId: string,
  ): Promise<ReconcileOutcome | undefined> {
    for (const attachment of attachments) {
      if (!attachment.pool_name) {
        throw new IncusError(
          attachment.shared ? 'VOLUME_PLACEMENT_PENDING' : 'MISSING_STORAGE_POOL',
          attachment.shared ? 'retry' : 'managed_failure',
          { volumeId: attachment.volume_id, serverId },
        );
      }
      if (attachment.shared) {
        const result = await ensureSharedCatalogOnServer(client, {
          poolName: attachment.pool_name,
          incusName: attachment.incus_name,
          sizeBytes: attachment.size_bytes,
        });
        if (result === 'missing') {
          if (context.intent.attemptCount >= VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS) {
            return failedOutcome(
                'VOLUME_CATALOG_ADOPT_FAILED',
                'Incus did not adopt the existing CephFS directory into this daemon catalog',
                { volumeId: attachment.volume_id, serverId },
              );
          }
          throw new IncusError('VOLUME_CATALOG_ADOPT_PENDING', 'retry', {
            volumeId: attachment.volume_id,
            serverId,
          });
        }
        await this.store.markCatalogPresent(attachment.volume_id, serverId);
        this.logger.log(
          `container=${context.intent.resourceId} ensure shared catalog volume=${attachment.volume_id} `
          + `server=${serverId} result=${result}`,
        );
        continue;
      }
      try {
        await client.getStorageVolume(attachment.pool_name, 'custom', attachment.incus_name);
        await this.store.markCatalogPresent(attachment.volume_id, serverId);
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
    return undefined;
  }

  // --- instance lifecycle --------------------------------------------------------

  private async reconcileDelete(
    context: ReconcileRunContext,
    client: IncusClientPort,
    row: ContainerRow,
    expectedName: string,
  ): Promise<ReconcileOutcome> {
    const actual = await this.findInstance(client, expectedName, row);
    const deleted = await this.deleteDesiredInstance(client, actual, row, context.intent);
    if (!deleted && actual) {
      return failedOutcome(
          'INSTANCE_DELETE_IDENTITY_MISMATCH',
          'The managed instance could not be safely deleted due to its identity',
        );
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
    const actual = await this.findInstance(client, expectedName, row);
    if (!actual) {
      await this.deleteManagedOrphans(client, row, context.intent);
      await this.auditMutate(context.intent, 'POST', '/1.0/instances', expectedName);
      await createInstance(client, desired, expectedName);
      await this.store.setInstanceName(row.id, expectedName);
      return readRequired(client, expectedName);
    }
    if (actual.name !== expectedName) {
      await renameInstance(client, actual.name, expectedName);
      return readRequired(client, expectedName);
    }
    return actual;
  }

  private async findInstance(
    client: IncusClientPort,
    expectedName: string,
    row: ContainerRow,
  ): Promise<ActualInstance | undefined> {
    const { actual, foreignServer } = await findExpectedOrIdentity(client, expectedName, row);
    if (foreignServer) {
      this.logger.warn(
        `Found container ${row.id} on a different server; refusing cross-server deletion`,
      );
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
      return failedOutcome(
          'UNMANAGED_INSTANCE_NAME_COLLISION',
          `Incus instance ${expectedName} is not managed by nyabase`,
        );
    }
    if (
      actualIdentity.containerId !== normalized(row.id)
      || actualIdentity.serverId !== normalized(row.server_id)
    ) {
      this.logger.warn(
        `Refusing to modify instance ${actual.name} with identity `
        + `${actualIdentity.containerId}/${actualIdentity.serverId}`,
      );
      return failedOutcome(
          'MANAGED_INSTANCE_IDENTITY_MISMATCH',
          'The managed instance identity does not match the desired container',
          {
            actualContainerId: actualIdentity.containerId,
            actualServerId: actualIdentity.serverId,
          },
        );
    }
    return null;
  }

  /** Stop (if running) and delete one instance; audited when an intent drives it. */
  private async deleteInstance(
    client: IncusClientPort,
    name: string,
    intent?: IntentRecord,
  ): Promise<void> {
    if (!name) return;
    if (intent) {
      await this.auditMutate(intent, 'DELETE', `/1.0/instances/${name}`, name);
    }
    await deletePhysicalInstance(client, name);
  }

  /** Delete the container's own instance, but only when it is ours and on this server. */
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
    await this.deleteInstance(client, actual.name, intent);
    return true;
  }

  /** Remove managed instances on the server that no live container row owns. */
  private async deleteManagedOrphans(
    client: IncusClientPort,
    row: ContainerRow,
    intent: IntentRecord,
  ): Promise<void> {
    const known = new Set(
      (await this.store.listLiveContainerIds(row.server_id)).map((id) => normalized(id)),
    );
    const instances = await client.listInstances(2);
    for (const document of orphanInstances(
      instances.metadata as InstanceFull[],
      row.server_id,
      known,
    )) {
      await this.deleteInstance(client, document.name!, intent);
    }
  }

  // --- root disk, power ------------------------------------------------------------

  /**
   * Refuse a root-disk shrink that would lose data (or cannot be judged), and
   * revert the desired size so the container stops asking for it.
   */
  private async guardRootShrink(
    row: ContainerRow,
    actual: ActualInstance,
    desired: DesiredInstanceSpec,
    state: InstanceState,
    usedBytes: bigint | null,
  ): Promise<void> {
    const actualRoot = observedDiskUsageBytes(
      (actual.document.devices?.root as Record<string, unknown> | undefined)?.size,
    );
    const desiredRoot = observedDiskUsageBytes(
      (desired.devices?.root as Record<string, unknown> | undefined)?.size,
    );
    if (actualRoot === null || desiredRoot === null) return;
    const decision = decideRootShrink({
      resizeFamily: row.root_resize_family,
      actualRootBytes: actualRoot,
      desiredRootBytes: desiredRoot,
      usedBytes,
      running: running(state),
    });
    if (decision === 'allow') return;
    const code = decision === 'requires_stop'
      ? 'ROOT_SHRINK_REQUIRES_STOP'
      : decision === 'usage_unknown'
        ? 'ROOT_USAGE_UNKNOWN'
        : 'ROOT_SHRINK_BELOW_USAGE';
    if (decision === 'usage_floor' || decision === 'usage_unknown') {
      await this.store.revertImpossibleRootShrink(row.id, actualRoot, usedBytes, code);
    }
    throw new IncusError(code, 'managed_failure', {
      containerId: row.id,
      requestedBytes: desiredRoot.toString(),
      usedBytes: usedBytes?.toString() ?? null,
    });
  }

  /** Start or stop the instance so its power state matches the desired power intent. */
  private async reconcilePower(
    context: ReconcileRunContext,
    client: IncusClientPort,
    row: ContainerRow,
    name: string,
    currentState: InstanceState,
  ): Promise<void> {
    if (context.intent.kind === 'container.power' && context.intent.request?.action === 'restart') {
      return;
    }
    const transition = powerTransition(currentState.status, row.power_intent);
    if (transition === 'none') return;
    await setPowerState(client, name, transition);
  }

  /** Restart, proven by a changed `started_at` against the baseline recorded at request time. */
  private async reconcileRestart(
    context: ReconcileRunContext,
    client: IncusClientPort,
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
    await restartWithProof(client, name, baselineStartedAt);
  }

  // --- verification and observation ----------------------------------------------

  /** Re-read the instance, check it matches the spec, record the observation and pick the outcome. */
  private async verifyAndSettle(
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
      return failedOutcome(
          'INSTANCE_VERIFY_FAILED',
          'The instance did not match the managed specification after reconciliation',
          {
            config: verificationDiff.config,
            devices: verificationDiff.devices,
          },
        );
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
        failure: intentFailure(
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
        failure: intentFailure(
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

  /** A full scan found the instance changed outside the platform; record what is being reverted. */
  private async auditDrift(intent: IntentRecord, diff: ManagedFieldsDiff): Promise<void> {
    await this.audit.log(
      intent.requestedBy,
      AuditAction.ContainerDriftCorrected,
      intent.resourceId,
      intent.resourceType,
      {
        serverId: intent.serverId,
        intentId: intent.id,
        config: Object.keys(diff.config).slice(0, 64),
        devices: Object.keys(diff.devices).slice(0, 64),
        profiles: diff.profiles === true,
      },
    );
  }

  private async auditMutate(
    intent: IntentRecord,
    method: string,
    path: string,
    instanceName: string,
  ): Promise<void> {
    await this.audit.log(
      intent.requestedBy,
      AuditAction.IncusMutate,
      intent.resourceId,
      intent.resourceType,
      { method, path, instanceName, serverId: intent.serverId, intentId: intent.id },
    );
  }

  // --- full scan -------------------------------------------------------------------

  /** Full scan: queue update/delete intents for drifted containers and remove orphaned instances. */
  async scan(serverId: string, client: IncusClientPort, signal: AbortSignal): Promise<void> {
    const rows = await this.store.listScanContainers(serverId);
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
      if (identity.managed && identity.serverId === normalized(serverId) && identity.containerId) {
        byContainerId.set(identity.containerId, { name: document.name ?? '', document });
      }
    }
    for (const desired of rows) {
      if (desired.needs_attention || desired.lifecycle_phase === 'failed') continue;
      if (desired.lifecycle_phase === 'deleting') {
        await this.store.enqueueScanIntent(desired, 'container.delete');
        continue;
      }
      const actual = byContainerId.get(normalized(desired.id));
      const usage = observedDiskUsageBytes(actual?.document.state?.disk?.root?.usage);
      if (usage !== null) {
        await this.store.recordRootUsage(desired.id, usage);
      }
      try {
        if (await this.scanNeedsUpdate(desired, deriveInstanceName(desired.id), actual)) {
          await this.store.enqueueScanIntent(desired, 'container.update');
        }
      } catch (error) {
        // One container that cannot be specified must not stop the scan of the others.
        this.logger.warn(`Full scan could not check container ${desired.id}: ${String(error)}`);
      }
    }
    for (const document of orphanInstances(documents, serverId, known)) {
      await this.deleteInstance(client, document.name!);
    }
    await this.cpuSets.releaseIdle(serverId);
  }

  /** Does the live instance differ from what the platform wants (name, power, managed fields)? */
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
    const full = await this.store.readContainer(row.id);
    if (!full?.parent_interface || !full.routed_ip || !full.network_key || !full.gateway) {
      return true;
    }
    const attachments = await this.store.readAttachments(row.id, row.server_id);
    const desired = buildContainerSpec(
      full,
      toSpecAttachments(attachments.filter((attachment) => attachment.bind_state !== 'detaching')),
      await resolveContainerRuntime(this.cpuSets, this.config, full, 'preview'),
    );
    return compareManagedFields(actual.document, desired, MANAGED_FIELD_OWNERSHIP).kind !== 'empty';
  }
}
