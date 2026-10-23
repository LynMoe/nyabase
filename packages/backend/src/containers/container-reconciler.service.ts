import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditAction, FailureCode } from '@nyabase/common';
import { AuditService } from '../iam/audit.service.js';
import { AccessChangeNotifier } from '../iam/access-resolver.service.js';
import { ReconcileWakeService } from '../reconcile/reconcile-wake.service.js';
import {
  compareManagedFields,
  deriveInstanceName,
  IncusError,
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
import { applyGuestNetwork, parseCidrPrefix } from './guest-network.adapter.js';
import {
  buildContainerSpec,
  createInstance,
  deletePhysicalInstance,
  findExpectedOrIdentity,
  MANAGED_FIELD_OWNERSHIP,
  managedContainerIdentity,
  normalized,
  observeRootUsage,
  powerTransition,
  putManagedFields,
  readRequired,
  readState,
  removeDevices,
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
  type ContainerRow,
  type SshFileObservation,
} from './container-reconcile.store.js';
import { isRestartIntent } from './container-rules.js';
import {
  awaitsSshDaemon,
  guardRootShrink,
  NotReadyPasses,
  prepareAttachments,
  rootShrinkDecision,
  scanServerContainers,
} from './container-reconcile-steps.js';
import {
  IncusContainerSshStateAdapter,
  hostCertificatePrincipals,
  reconcileHostCertificate,
  reconcileSshFile,
} from './container-ssh.js';
import { SshHostCaService } from '../ssh-host-ca/ssh-host-ca.service.js';

type Loaded =
  | { readonly outcome: ReconcileOutcome }
  | { readonly row: ContainerRow; readonly prefixLength: number };

/**
 * Drives container intents against Incus: converge the instance (create,
 * rename, managed fields, power, guest network, SSH key) or delete it. The
 * steps are private methods; the Incus operations are plain functions in
 * container-instance-ops and all SQL is in the store.
 */
/** Root quota polls: 5 s doubling to a minute, about an hour in all. */
const ROOT_QUOTA_MAX_ATTEMPTS = 64;

export function rootQuotaRetryDelay(attemptCount: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.min(4, Math.max(0, attemptCount - 1)));
}

@Injectable()
export class ContainerReconciler implements ManagedReconciler, OnModuleInit {
  readonly resourceType = 'container' as const;
  private readonly logger = new Logger(ContainerReconciler.name);
  private readonly notReady = new NotReadyPasses();

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
    private readonly hostCa: SshHostCaService,
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
    await this.beforeAttachments(context, client, row, expectedName);
    const prepared = await prepareAttachments(
      { store: this.store, logger: this.logger, notReady: this.notReady },
      context,
      client,
      row,
    );
    if ('outcome' in prepared) return prepared.outcome;
    const desiredAttachments = prepared.attachments;
    const runtime = await resolveContainerRuntime(this.cpuSets, this.config, row);
    const desired = buildContainerSpec(row, toSpecAttachments(desiredAttachments), runtime);

    const actual = await this.ensureInstance(context, client, row, desired, expectedName);
    const identityOutcome = this.checkIdentity(actual, row, expectedName);
    if (identityOutcome) return identityOutcome;

    let state = await readState(client, expectedName);
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
    state = await this.stopForDisruptiveChange(context, client, row, actual, desired, diff, state);
    const usedBytes = await observeRootUsage(client, row.root_pool_name, expectedName, state);
    await guardRootShrink(this.store, row, actual, desired, state, usedBytes);
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

    state = await this.reconcilePower(context, client, row, expectedName, state);
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
    if (ssh.status === 'running') await this.convergeHostCertificate(context, client, row, expectedName);
    const outcome = await this.verifyAndSettle(context.intent, client, row, desired, expectedName, ssh);
    if (outcome.outcome === 'succeeded' && !sameCpus(row.cpu_set, runtime.cpus)) {
      await this.store.recordCpuSet(row.id, runtime.cpus);
    }
    return outcome;
  }

  /** Best effort: a guest without a certificate still works, with trust-on-first-use. */
  private async convergeHostCertificate(
    context: ReconcileRunContext,
    client: IncusClientPort,
    row: ContainerRow,
    name: string,
  ): Promise<void> {
    try {
      const outcome = await reconcileHostCertificate(
        this.sshState,
        client,
        name,
        (hostPublicKey) => this.hostCa.certify({
          ownerId: row.owner_id,
          hostPublicKey,
          principals: hostCertificatePrincipals(row.name, this.config.get<string>('ssh.proxyHostSuffix')),
          keyId: `nyabase:${row.id}`,
        }),
        () => this.auditMutate(context.intent, 'POST', `/1.0/instances/${name}/exec`, name),
        context.signal,
      );
      if (outcome !== 'current' && outcome !== 'issued') {
        this.logger.warn(`Container ${row.id} has no SSH host certificate: ${outcome}`);
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      this.logger.warn(`Container ${row.id} SSH host certificate failed: ${String(error)}`);
    }
  }

  // --- loading and preparation ---------------------------------------------------

  /**
   * Load the desired container and refuse intents that cannot be applied to it.
   * `stale` outcomes settle the intent without touching Incus. A deleting
   * container is never stale (any intent drives it to deletion), and a
   * superseded restart is carried forward onto the current revision unless a
   * later stop or delete replaced it.
   */
  private async load(context: ReconcileRunContext): Promise<Loaded> {
    const { intent } = context;
    const row = await this.store.readContainer(intent.resourceId);
    if (!row) {
      // Only a finished delete removes the row; a retried delete (lease lost after it) is done.
      if (intent.kind === 'container.delete') {
        return { outcome: { outcome: 'succeeded', observedRevision: intent.targetRevision, stale: true } };
      }
      return {
        outcome: failedOutcome('CONTAINER_NOT_FOUND', 'The desired container no longer exists'),
      };
    }
    if (row.server_id !== intent.serverId) {
      return {
        outcome: failedOutcome('CONTAINER_SERVER_MISMATCH', 'The intent server does not own the container'),
      };
    }
    const restart = isRestartIntent(intent.kind, intent.request);
    if (restart && (row.lifecycle_phase === 'deleting' || row.power_intent !== 'running')) {
      return {
        outcome: {
          ...failedOutcome('RESTART_SUPERSEDED', 'A later stop or delete replaced the restart before it ran'),
          stale: true,
        },
      };
    }
    if (!restart && row.lifecycle_phase !== 'deleting' && intent.targetRevision < row.revision) {
      return {
        outcome: { outcome: 'succeeded', observedRevision: intent.targetRevision, stale: true },
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
   * Powering off and unplugging never wait for the other attachments: a
   * volume that is not ready on this server (its create failed, a placement
   * is pending) would hold the stop or the detach, the access-lapse ones
   * included, in retries (and then a failure) while the instance keeps
   * running, or keeps the detached volume mounted. A detach that lands here
   * settles its attachment row at once, whatever the rest of the pass does.
   */
  private async beforeAttachments(
    context: ReconcileRunContext,
    client: IncusClientPort,
    row: ContainerRow,
    expectedName: string,
  ): Promise<void> {
    const detaching = await this.store.readDetachingDevices(row.id);
    if (row.power_intent !== 'stopped' && detaching.length === 0) return;
    const actual = await this.findInstance(client, expectedName, row);
    if (!actual) {
      // No instance on this server: nothing carries the detached volumes.
      if (detaching.length > 0) await this.store.settleVolumeBinds(row.id, { devices: {} }, true);
      return;
    }
    if (this.checkIdentity(actual, row, expectedName)) return;
    const status = actual.document.state?.status ?? actual.document.status;
    if (row.power_intent === 'stopped' && powerTransition(status, 'stopped') === 'stop') {
      await setPowerState(client, actual.name, 'stop');
    }
    if (detaching.length === 0) return;
    let document = actual.document;
    if (detaching.some((device) => Object.prototype.hasOwnProperty.call(document.devices ?? {}, device))) {
      await this.auditMutate(context.intent, 'PUT', `/1.0/instances/${actual.name}`, actual.name);
      await removeDevices(client, actual.name, detaching);
      document = (await readRequired(client, actual.name)).document;
    }
    await this.store.settleVolumeBinds(row.id, document, true);
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

  // --- power ------------------------------------------------------------------------

  /**
   * A change only a stopped instance can take (GPU runtime/devices, a
   * block-backed root shrink) must never block power-off: when the instance
   * should be stopped, or is due a restart, stop it first and apply the change
   * while stopped. A container that should keep running reports the change.
   */
  private async stopForDisruptiveChange(
    context: ReconcileRunContext,
    client: IncusClientPort,
    row: ContainerRow,
    actual: ActualInstance,
    desired: DesiredInstanceSpec,
    diff: ManagedFieldsDiff,
    state: InstanceState,
  ): Promise<InstanceState> {
    if (!running(state)) return state;
    if (row.power_intent !== 'stopped' && !isRestartIntent(context.intent.kind, context.intent.request)) {
      return state;
    }
    const disruptive = (!diff.empty && gpuRequiresStop(diff))
      || rootShrinkDecision(row, actual, desired, null, true).decision === 'requires_stop';
    if (!disruptive) return state;
    await setPowerState(client, actual.name, 'stop');
    return readState(client, actual.name);
  }

  /** Start or stop the instance so its power state matches the desired power intent. */
  private async reconcilePower(
    context: ReconcileRunContext,
    client: IncusClientPort,
    row: ContainerRow,
    name: string,
    currentState: InstanceState,
  ): Promise<InstanceState> {
    // Restarting a running instance is the restart step's job; a stopped one is started here.
    if (isRestartIntent(context.intent.kind, context.intent.request) && running(currentState)) {
      return currentState;
    }
    const transition = powerTransition(currentState.status, row.power_intent);
    if (transition === 'none') return currentState;
    await setPowerState(client, name, transition);
    return readState(client, name);
  }

  /** Restart, proven by a changed `started_at` against the baseline recorded at request time. */
  private async reconcileRestart(
    context: ReconcileRunContext,
    client: IncusClientPort,
    name: string,
    currentState: InstanceState,
  ): Promise<void> {
    if (!isRestartIntent(context.intent.kind, context.intent.request)) return;
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
    intent: IntentRecord,
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
      const failure = intentFailure(
        'ROOT_QUOTA_PENDING',
        'Incus has not finished applying the root filesystem quota',
        { pendingSizeBytes: quota.pendingSizeBytes ?? row.root_size_bytes },
      );
      // Every pass re-runs the guest network and SSH steps: back off, and
      // give up (a user retry restarts it) instead of polling forever.
      if (intent.attemptCount >= ROOT_QUOTA_MAX_ATTEMPTS) return { outcome: 'failed', failure };
      return { outcome: 'retry', failure, retryAfterMs: rootQuotaRetryDelay(intent.attemptCount) };
    }
    if (
      running(verifiedState)
      && row.ssh_public_key
      && awaitsSshDaemon(intent)
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

  scan(serverId: string, client: IncusClientPort, signal: AbortSignal): Promise<void> {
    return scanServerContainers(
      { store: this.store, cpuSets: this.cpuSets, config: this.config, logger: this.logger },
      serverId,
      client,
      signal,
    );
  }
}
