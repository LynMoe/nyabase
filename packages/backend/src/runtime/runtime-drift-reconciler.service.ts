import { Injectable } from '@nestjs/common';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  AgentTaskKind,
  AgentTaskStatus,
  canonicalIpv4Address,
  CONTAINER_DELETE_PROXY_DRAIN_MS,
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  LABEL,
  MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER,
  ServerStatus,
  parseAgentTaskPayload,
  type ContainerMountSpec,
  type ContainerRuntimeAbsentTaskPayload,
  type ContainerSnapshot,
} from '@nyabase/common';
import type { Transaction } from 'kysely';
import { WorkflowEnqueuePort } from '../agent-tasks/workflow-enqueue.port.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { ResourceLockedException } from '../agent-tasks/resource-lock.error.js';
import {
  WorkflowRepository,
  type WorkflowTaskRecord,
} from '../agent-tasks/workflow.repository.js';
import {
  monotonicReuseGuard,
  networkClaimReuseKey,
} from '../common/monotonic-reuse-guard.js';
import { MAX_NETWORK_ADDRESS_CLAIMS_GLOBAL } from '../common/network-claim.constants.js';
import {
  ContainerControlRepository,
  type ContainerAggregate,
  type ContainerNetworkClaimRecord,
} from '../containers/container-control.repository.js';
import {
  ContainerMountIntegrityError,
  resolveContainerMountIntegrity,
} from '../containers/container-mount-integrity.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';

const INVENTORY_QUARANTINE_CODE = 'AGENT_INVENTORY_FAULT';
const NETWORK_CLAIM_GC_BATCH = 4_096;

class RuntimeCleanupLedgerCorruptionError extends Error {}
class RuntimeDriftFenceConflictError extends Error {}

const RUNTIME_DRIFT_FENCE_MAX_ATTEMPTS = 3;

export interface RuntimeDriftReconcileResult {
  taskIds: string[];
  failedContainerIds: string[];
  claimsChanged: boolean;
  quarantineReason: string | null;
}

/**
 * Converts one authoritative Agent inventory into PostgreSQL-owned convergence
 * tasks and exact runtime cleanup claims.
 */
@Injectable()
export class RuntimeDriftReconcilerService {
  constructor(
    private readonly transactions: PgTransactionManager,
    private readonly containers: ContainerControlRepository,
    private readonly workflow: WorkflowEnqueuePort,
    private readonly workflowRepository: WorkflowRepository,
    private readonly resourceKeys: ResourceKeyService,
  ) {}

  async reconcile(
    serverId: string,
    snapshots: readonly ContainerSnapshot[],
    dockerRoot: string,
  ): Promise<RuntimeDriftReconcileResult> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.transactions.run(async (transaction) => {
          try {
        await this.gcExpiredClaims(transaction);
        const productIds = [...new Set(
          snapshots.map((snapshot) => this.productId(snapshot)),
        )];
        const [onServer, claimed, server, claims] = await Promise.all([
          this.containers.list({ serverId }, transaction),
          productIds.length === 0
            ? Promise.resolve([])
            : this.containers.findByIds(productIds, transaction),
          transaction.selectFrom('infra.servers')
            .select(['id', 'macvlan_cidr'])
            .where('id', '=', serverId)
            .executeTakeFirst(),
          this.containers.activeNetworkClaims({}, transaction),
        ]);
        if (!server?.macvlan_cidr) {
          throw new Error('Server network identity is not bound');
        }
        const aggregateById = new Map(
          [...onServer, ...claimed].map((container) => [container.id, container]),
        );
        const activeTasksById = await this.workflowRepository.findTasks(
          [...new Set([...aggregateById.values()]
            .flatMap((container) => container.activeTaskId ? [container.activeTaskId] : []))],
          transaction,
        );
        const claimByContainer = new Map(claims
          .filter((claim) => claim.ownerKind === 'container' && claim.containerId)
          .map((claim) => [claim.containerId!, claim]));
        const reportedByProduct = this.groupByProduct(snapshots);
        const taskIds: string[] = [];
        const failedContainerIds: string[] = [];
        let claimsChanged = false;

        for (const [containerId, reported] of [...reportedByProduct.entries()]
          .sort(([left], [right]) => left.localeCompare(right))) {
          const container = aggregateById.get(containerId);
          if (!container || container.serverId !== serverId) {
            const cleanup = await this.scheduleRuntimeCleanups(
              transaction,
              serverId,
              server.macvlan_cidr,
              reported,
              dockerRoot,
            );
            taskIds.push(...cleanup.taskIds);
            claimsChanged ||= cleanup.claimsChanged;
            continue;
          }
          const claim = claimByContainer.get(container.id);
          const canonical = reported.find((snapshot) =>
            this.isCanonical(snapshot, container, claim?.address ?? null));

          if (container.activeTaskId) {
            const active = activeTasksById.get(container.activeTaskId);
            if (!active || active.status !== AgentTaskStatus.Pending) {
              const cleanup = await this.scheduleRuntimeCleanups(
                transaction, serverId, server.macvlan_cidr, reported, dockerRoot,
              );
              taskIds.push(...cleanup.taskIds);
              claimsChanged ||= cleanup.claimsChanged;
              await this.markFailed(
                transaction,
                container,
                'runtime_lifecycle_owner_missing',
                `Container lifecycle is ${container.lifecyclePhase} but has no active durable task owner`,
              );
              failedContainerIds.push(container.id);
              continue;
            }
            const prioritized = canonical
              ? await this.prioritizePowerAheadOfSsh(
                transaction,
                container,
                active,
                canonical,
                dockerRoot,
              )
              : null;
            if (prioritized) {
              if (prioritized.taskId) taskIds.push(prioritized.taskId);
              if (prioritized.failed) failedContainerIds.push(container.id);
              const cleanup = await this.scheduleRuntimeCleanups(
                transaction,
                serverId,
                server.macvlan_cidr,
                reported.filter((snapshot) => snapshot !== canonical),
                dockerRoot,
              );
              taskIds.push(...cleanup.taskIds);
              claimsChanged ||= cleanup.claimsChanged;
              continue;
            }
            const ownedRuntimeId = container.boundRuntimeId
              ?? this.stagedRuntimeId(active);
            if (!ownedRuntimeId) {
              if (this.isUnboundDeleteTask(active)) {
                const cleanup = await this.scheduleRuntimeCleanups(
                  transaction, serverId, server.macvlan_cidr, reported, dockerRoot,
                );
                taskIds.push(...cleanup.taskIds);
                claimsChanged ||= cleanup.claimsChanged;
              } else {
                claimsChanged = await this.ensureRuntimeClaims(
                  transaction, serverId, server.macvlan_cidr, reported, dockerRoot,
                ) || claimsChanged;
              }
              continue;
            }
            const owned = reported.find((snapshot) =>
              snapshot.runtime.runtimeId === ownedRuntimeId);
            if (!owned || claim?.address === owned.runtime.ip) {
              claimsChanged = await this.releaseRuntimeClaim(
                transaction, serverId, ownedRuntimeId,
              ) || claimsChanged;
            } else {
              claimsChanged = await this.ensureRuntimeClaims(
                transaction, serverId, server.macvlan_cidr, [owned], dockerRoot,
              ) || claimsChanged;
            }
            const cleanup = await this.scheduleRuntimeCleanups(
              transaction,
              serverId,
              server.macvlan_cidr,
              reported.filter((snapshot) => snapshot !== owned),
              dockerRoot,
            );
            taskIds.push(...cleanup.taskIds);
            claimsChanged ||= cleanup.claimsChanged;
            continue;
          }

          if (this.isTransitionPhase(container.lifecyclePhase)) {
            const cleanup = await this.scheduleRuntimeCleanups(
              transaction, serverId, server.macvlan_cidr, reported, dockerRoot,
            );
            taskIds.push(...cleanup.taskIds);
            claimsChanged ||= cleanup.claimsChanged;
            await this.markFailed(
              transaction,
              container,
              'runtime_lifecycle_owner_missing',
              `Container lifecycle is ${container.lifecyclePhase} but has no active durable task owner`,
            );
            failedContainerIds.push(container.id);
            continue;
          }

          if (canonical) {
            claimsChanged = await this.releaseRuntimeClaim(
              transaction,
              serverId,
              canonical.runtime.runtimeId,
            ) || claimsChanged;
          }
          const extras = reported.filter((snapshot) => snapshot !== canonical);
          if (extras.length > 0) {
            const cleanup = await this.scheduleRuntimeCleanups(
              transaction, serverId, server.macvlan_cidr, extras, dockerRoot,
            );
            taskIds.push(...cleanup.taskIds);
            claimsChanged ||= cleanup.claimsChanged;
          }
          if (container.lifecyclePhase === ContainerPhase.Active && !canonical) {
            await this.markRuntimeMissing(transaction, container, reported);
            failedContainerIds.push(container.id);
            continue;
          }
          if (
            container.lifecyclePhase === ContainerPhase.Active
            && canonical
            && extras.length === 0
          ) {
            const recovery = await this.schedulePowerRecovery(
              transaction,
              container,
              canonical,
              dockerRoot,
            );
            if (recovery.taskId) taskIds.push(recovery.taskId);
            if (recovery.failed) failedContainerIds.push(container.id);
          }
        }

        for (const container of onServer) {
          if (
            container.activeTaskId
            || reportedByProduct.has(container.id)
          ) continue;
          if (this.isTransitionPhase(container.lifecyclePhase)) {
            await this.markFailed(
              transaction,
              container,
              'runtime_lifecycle_owner_missing',
              `Container lifecycle is ${container.lifecyclePhase} but has no active durable task owner`,
            );
            failedContainerIds.push(container.id);
            continue;
          }
          if (
            container.lifecyclePhase !== ContainerPhase.Active
            && !(
              container.lifecyclePhase === ContainerPhase.Failed
              && container.failureCode === 'runtime_power_state_unsupported'
            )
          ) continue;
          await this.markRuntimeMissing(transaction, container, []);
          failedContainerIds.push(container.id);
        }

        taskIds.push(...await this.recoverAbsentRuntimeClaims(
          transaction,
          serverId,
          snapshots,
        ));
        return {
          taskIds: [...new Set(taskIds)],
          failedContainerIds: [...new Set(failedContainerIds)],
          claimsChanged,
          quarantineReason: null,
        };
          } catch (error) {
            if (!(error instanceof RuntimeCleanupLedgerCorruptionError)) throw error;
            const reason = error.message.slice(0, 2048);
            await transaction.updateTable('infra.servers').set({
              status: ServerStatus.AgentQuarantined,
              quarantine_code: INVENTORY_QUARANTINE_CODE,
              quarantine_message: reason,
            }).where('id', '=', serverId).executeTakeFirstOrThrow();
            return {
              taskIds: [],
              failedContainerIds: [],
              claimsChanged: true,
              quarantineReason: reason,
            };
          }
        });
      } catch (error) {
        // Task-result projection and inventory reconciliation use independent
        // short transactions. If the task result advances a container revision
        // after this report read it, roll back every reconciliation side effect
        // and rebuild from the new durable aggregate instead of disconnecting
        // an otherwise healthy Agent.
        if (
          !(error instanceof RuntimeDriftFenceConflictError)
          || attempt >= RUNTIME_DRIFT_FENCE_MAX_ATTEMPTS
        ) throw error;
      }
    }
  }

  private async scheduleRuntimeCleanups(
    transaction: Transaction<NyabaseDatabase>,
    serverId: string,
    networkKey: string,
    snapshots: readonly ContainerSnapshot[],
    dockerRoot: string,
  ): Promise<{ taskIds: string[]; claimsChanged: boolean }> {
    const sorted = [...snapshots].sort((left, right) =>
      left.runtime.runtimeId.localeCompare(right.runtime.runtimeId));
    const claimsChanged = await this.ensureRuntimeClaims(
      transaction, serverId, networkKey, sorted, dockerRoot,
    );
    const taskIds: string[] = [];
    for (const snapshot of sorted) {
      const payload = this.runtimeCleanupPayload(snapshot, serverId, dockerRoot);
      const existing = await this.pendingCleanupTask(
        transaction,
        serverId,
        payload,
      );
      if (existing) {
        if (existing.admissionClass !== 'safety') {
          await transaction.updateTable('workflow.tasks')
            .set({ admission_class: 'safety' })
            .where('id', '=', existing.id)
            .where('status', '=', AgentTaskStatus.Pending)
            .execute();
        }
        taskIds.push(existing.id);
        continue;
      }
      try {
        const task = await this.enqueueRuntimeCleanup(
          transaction,
          serverId,
          payload,
          'safety',
        );
        taskIds.push(task.taskId);
      } catch (error) {
        if (error instanceof ResourceLockedException || this.isQueueFull(error)) {
          continue;
        }
        throw error;
      }
    }
    return { taskIds, claimsChanged };
  }

  private async ensureRuntimeClaims(
    transaction: Transaction<NyabaseDatabase>,
    serverId: string,
    networkKey: string,
    snapshots: readonly ContainerSnapshot[],
    dockerRoot: string,
  ): Promise<boolean> {
    if (snapshots.length === 0) return false;
    const all = await this.containers.allNetworkClaims(transaction);
    const runtimeClaims = all.filter((claim) =>
      claim.ownerKind === 'runtime_cleanup' && claim.serverId === serverId);
    const activeCount = runtimeClaims.filter((claim) =>
      claim.state === 'active').length;
    if (activeCount > MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER) {
      throw new RuntimeCleanupLedgerCorruptionError(
        `Server ${serverId} has ${activeCount} active runtime cleanup claims; maximum is ${MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER}`,
      );
    }
    let changed = false;
    const initialClaimCount = all.length;
    let additionalRows = 0;
    let additionalActive = 0;
    for (const snapshot of snapshots) {
      const payload = this.runtimeCleanupPayload(snapshot, serverId, dockerRoot);
      const address = canonicalIpv4Address(snapshot.runtime.ip);
      const existing = runtimeClaims.find((claim) =>
        claim.ownerId === snapshot.runtime.runtimeId);
      if (existing) {
        if (
          existing.address !== address
          || existing.networkKey !== networkKey
          || !isDeepStrictEqual(
            this.cleanupIdentity(
              parseAgentTaskPayload(
                AgentTaskKind.ContainerRuntimeAbsent,
                existing.cleanupPayload,
              ) as ContainerRuntimeAbsentTaskPayload,
            ),
            this.cleanupIdentity(payload),
          )
        ) {
          throw new RuntimeCleanupLedgerCorruptionError(
            `Runtime ${snapshot.runtime.runtimeId} changed immutable cleanup evidence`,
          );
        }
        if (existing.state === 'releasing') {
          if (!await this.containers.reactivateRuntimeCleanupClaim(
            existing.id,
            payload,
            transaction,
          )) throw new RuntimeCleanupLedgerCorruptionError(
            `Runtime ${snapshot.runtime.runtimeId} lost its cleanup claim fence`,
          );
          changed = true;
        }
        continue;
      }
      if (
        activeCount + additionalActive + 1
          > MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER
      ) {
        throw new RuntimeCleanupLedgerCorruptionError(
          `Server ${serverId} runtime cleanup claim capacity would be exceeded`,
        );
      }
      const addressClaim = all.find((claim) =>
        claim.networkKey === networkKey && claim.address === address);
      if (addressClaim) {
        const productId = this.productId(snapshot);
        if (
          addressClaim.ownerKind === 'container'
          && addressClaim.ownerId === productId
          && addressClaim.serverId === serverId
          && addressClaim.containerId === productId
          && addressClaim.state === 'active'
        ) {
          // A create result can reach the Agent inventory before its durable
          // task result has been projected into the container aggregate. The
          // active reservation already fences this exact product runtime, so
          // it needs neither a second cleanup claim nor server quarantine.
          continue;
        }
        if (
          addressClaim.ownerKind !== 'container'
          || addressClaim.ownerId !== productId
          || addressClaim.serverId !== serverId
          || addressClaim.containerId !== null
          || addressClaim.state !== 'releasing'
        ) {
          throw new RuntimeCleanupLedgerCorruptionError(
            `Runtime ${snapshot.runtime.runtimeId} address ${address} is fenced by ${addressClaim.ownerKind} owner ${addressClaim.ownerId}`,
          );
        }
        if (!await this.containers.adoptReleasedContainerClaimForRuntimeCleanup({
          containerId: productId,
          runtimeId: snapshot.runtime.runtimeId,
          serverId,
          networkKey,
          address,
          cleanupPayload: payload,
        }, transaction)) {
          throw new RuntimeCleanupLedgerCorruptionError(
            `Runtime ${snapshot.runtime.runtimeId} lost its released container claim fence`,
          );
        }
        const adopted: ContainerNetworkClaimRecord = {
          ...addressClaim,
          containerId: null,
          ownerKind: 'runtime_cleanup',
          ownerId: snapshot.runtime.runtimeId,
          state: 'active',
          reusableAt: null,
          cleanupPayload: payload,
        };
        all[all.indexOf(addressClaim)] = adopted;
        runtimeClaims.push(adopted);
        additionalActive += 1;
        changed = true;
        continue;
      }
      additionalRows += 1;
      additionalActive += 1;
      if (initialClaimCount + additionalRows > MAX_NETWORK_ADDRESS_CLAIMS_GLOBAL) {
        throw new RuntimeCleanupLedgerCorruptionError(
          `Server ${serverId} runtime cleanup claim capacity would be exceeded`,
        );
      }
      const claimId = randomUUID();
      await this.containers.insertRuntimeCleanupClaim({
        id: claimId,
        runtimeId: snapshot.runtime.runtimeId,
        serverId,
        networkKey,
        address,
        cleanupPayload: payload,
      }, transaction);
      const inserted: ContainerNetworkClaimRecord = {
        id: claimId,
        containerId: null,
        ownerKind: 'runtime_cleanup',
        ownerId: snapshot.runtime.runtimeId,
        serverId,
        networkKey,
        address,
        state: 'active',
        reusableAt: null,
        cleanupPayload: payload,
      };
      all.push(inserted);
      runtimeClaims.push(inserted);
      changed = true;
    }
    return changed;
  }

  private async pendingCleanupTask(
    transaction: Transaction<NyabaseDatabase>,
    serverId: string,
    payload: ContainerRuntimeAbsentTaskPayload,
  ): Promise<WorkflowTaskRecord | null> {
    const rows = await transaction.selectFrom('workflow.tasks')
      .selectAll()
      .where('kind', '=', AgentTaskKind.ContainerRuntimeAbsent)
      .where('server_id', '=', serverId)
      .where('resource_type', '=', 'container_runtime')
      .where('resource_id', '=', payload.runtimeId)
      .where('status', '=', AgentTaskStatus.Pending)
      .orderBy('id')
      .limit(2)
      .execute();
    if (rows.length > 1) {
      throw new RuntimeCleanupLedgerCorruptionError(
        `Runtime ${payload.runtimeId} has multiple pending cleanup authorities`,
      );
    }
    if (rows.length === 0) return null;
    const task = await this.workflowRepository.findTask(rows[0]!.id, transaction);
    if (!task) return null;
    try {
      const durable = parseAgentTaskPayload(
        AgentTaskKind.ContainerRuntimeAbsent,
        task.payload,
      ) as ContainerRuntimeAbsentTaskPayload;
      return isDeepStrictEqual(
        this.cleanupIdentity(durable),
        this.cleanupIdentity(payload),
      ) ? task : null;
    } catch {
      return null;
    }
  }

  private enqueueRuntimeCleanup(
    transaction: Transaction<NyabaseDatabase>,
    serverId: string,
    payload: ContainerRuntimeAbsentTaskPayload,
    admissionClass: 'safety' | 'reconciliation',
  ) {
    return this.workflow.enqueueInTransaction(transaction, {
      kind: AgentTaskKind.ContainerRuntimeAbsent,
      serverId,
      resourceType: 'container_runtime',
      resourceId: payload.runtimeId,
      requestedBy: null,
      request: { reason: 'authoritative_state_report_drift' },
      payload,
      resourceKeys: [this.resourceKeys.runtime(serverId, payload.runtimeId)],
      admissionClass,
    });
  }

  private runtimeCleanupPayload(
    snapshot: ContainerSnapshot,
    serverId: string,
    dockerRoot: string,
  ): ContainerRuntimeAbsentTaskPayload {
    const labels = snapshot.labels ?? {};
    try {
      return parseAgentTaskPayload(AgentTaskKind.ContainerRuntimeAbsent, {
        runtimeId: snapshot.runtime.runtimeId,
        containerId: this.productId(snapshot),
        serverId,
        specGeneration: labels[LABEL.SPEC_GENERATION],
        runtimeSpecHash: labels[LABEL.RUNTIME_SPEC_HASH],
        quotaPaths: this.canonicalQuotaPaths(snapshot, dockerRoot),
        observedIp: canonicalIpv4Address(snapshot.runtime.ip),
      }) as ContainerRuntimeAbsentTaskPayload;
    } catch (error) {
      throw new RuntimeCleanupLedgerCorruptionError(
        `Runtime ${snapshot.runtime.runtimeId} has invalid cleanup identity: ${
          this.errorMessage(error)
        }`,
      );
    }
  }

  private async recoverAbsentRuntimeClaims(
    transaction: Transaction<NyabaseDatabase>,
    serverId: string,
    snapshots: readonly ContainerSnapshot[],
  ): Promise<string[]> {
    const reported = new Set(
      snapshots.map((snapshot) => snapshot.runtime.runtimeId),
    );
    const claims = (await this.containers.runtimeCleanupClaims(
      serverId,
      transaction,
    )).filter((claim) => claim.state === 'active' && !reported.has(claim.ownerId));
    if (claims.length > MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER) {
      throw new RuntimeCleanupLedgerCorruptionError(
        `Server ${serverId} exceeds the bounded runtime cleanup claim authority`,
      );
    }
    const taskIds: string[] = [];
    for (const claim of claims) {
      let payload: ContainerRuntimeAbsentTaskPayload;
      try {
        payload = parseAgentTaskPayload(
          AgentTaskKind.ContainerRuntimeAbsent,
          claim.cleanupPayload,
        ) as ContainerRuntimeAbsentTaskPayload;
      } catch (error) {
        throw new RuntimeCleanupLedgerCorruptionError(
          `Runtime cleanup claim ${claim.id} has invalid evidence: ${
            this.errorMessage(error)
          }`,
        );
      }
      if (
        payload.runtimeId !== claim.ownerId
        || payload.serverId !== serverId
        || payload.observedIp !== claim.address
      ) throw new RuntimeCleanupLedgerCorruptionError(
        `Runtime cleanup claim ${claim.id} has mismatched immutable evidence`,
      );
      const existing = await this.pendingCleanupTask(
        transaction,
        serverId,
        payload,
      );
      if (existing) {
        if (existing.admissionClass === 'safety') {
          await transaction.updateTable('workflow.tasks')
            .set({ admission_class: 'reconciliation' })
            .where('id', '=', existing.id)
            .execute();
        }
        taskIds.push(existing.id);
        continue;
      }
      try {
        taskIds.push((await this.enqueueRuntimeCleanup(
          transaction,
          serverId,
          payload,
          'reconciliation',
        )).taskId);
      } catch (error) {
        if (error instanceof ResourceLockedException || this.isQueueFull(error)) {
          continue;
        }
        throw error;
      }
    }
    return taskIds;
  }

  private async schedulePowerRecovery(
    transaction: Transaction<NyabaseDatabase>,
    container: ContainerAggregate,
    canonical: ContainerSnapshot,
    dockerRoot: string,
  ): Promise<{ taskId: string | null; failed: boolean }> {
    const wantsRunning = container.powerIntent === ContainerPowerIntent.Running;
    const isRunning = canonical.status === ContainerStatus.Running;
    const isStopped = canonical.status === ContainerStatus.Exited
      || canonical.status === ContainerStatus.Dead;
    if (!isRunning && !isStopped) {
      await this.markFailed(
        transaction,
        container,
        'runtime_power_state_unsupported',
        `Canonical runtime ${canonical.runtime.runtimeId} reported unsupported power state ${canonical.status}`,
      );
      return { taskId: null, failed: true };
    }
    if ((wantsRunning && isRunning) || (!wantsRunning && isStopped)) {
      return { taskId: null, failed: false };
    }
    let kind: AgentTaskKind;
    let payload: Record<string, unknown>;
    let resourceKeys = [this.resourceKeys.container(container.id)];
    if (wantsRunning) {
      let start: Awaited<ReturnType<typeof this.startRecoveryPayload>>;
      try {
        start = await this.startRecoveryPayload(
          transaction,
          container,
          dockerRoot,
        );
      } catch (error) {
        if (!(error instanceof ContainerMountIntegrityError)) throw error;
        const code = error.kind === 'desired_invalid'
          ? 'runtime_power_recovery_mount_spec_invalid'
          : error.kind === 'index_divergent'
            ? 'runtime_power_recovery_mount_index_divergent'
            : 'runtime_power_recovery_mount_source_unavailable';
        await this.markFailed(transaction, container, code, error.message);
        return { taskId: null, failed: true };
      }
      if (!start) {
        await this.markFailed(
          transaction,
          container,
          'runtime_power_recovery_precondition_missing',
          'A stopped canonical runtime cannot be restarted because durable quota or mount recovery metadata is incomplete',
        );
        return { taskId: null, failed: true };
      }
      kind = AgentTaskKind.ContainerStart;
      payload = start.payload;
      resourceKeys = start.resourceKeys;
    } else {
      kind = AgentTaskKind.ContainerStop;
      payload = {
        containerId: container.id,
        runtimeId: container.boundRuntimeId,
      };
    }
    try {
      const task = await this.workflow.enqueueInTransaction(transaction, {
        kind,
        serverId: container.serverId,
        resourceType: 'container',
        resourceId: container.id,
        requestedBy: null,
        request: { reason: 'authoritative_state_report_power_recovery' },
        payload,
        resourceKeys,
        admissionClass: 'reconciliation',
        beforeCommit: async (taskTransaction, context) => {
          if (!await this.containers.transition(
            container.id,
            container.revision,
            {
              lifecyclePhase: ContainerPhase.Updating,
              activeTaskId: context.taskId,
              failureReason: null,
              failureCode: null,
            },
            taskTransaction,
          )) throw new RuntimeDriftFenceConflictError(
            `Container ${container.id} lost its recovery fence`,
          );
        },
      });
      return { taskId: task.taskId, failed: false };
    } catch (error) {
      if (error instanceof ResourceLockedException || this.isQueueFull(error)) {
        return { taskId: null, failed: false };
      }
      throw error;
    }
  }

  private async prioritizePowerAheadOfSsh(
    transaction: Transaction<NyabaseDatabase>,
    container: ContainerAggregate,
    active: WorkflowTaskRecord,
    canonical: ContainerSnapshot,
    dockerRoot: string,
  ): Promise<{ taskId: string | null; failed: boolean } | null> {
    if (
      active.kind !== AgentTaskKind.ContainerSshEnsure
      || active.serverId !== container.serverId
      || active.resourceType !== 'container'
      || active.resourceId !== container.id
      || active.agentResult !== null
      || active.startedAt !== null
      || active.lastSentAt !== null
      || container.powerIntent !== ContainerPowerIntent.Running
      || (
        canonical.status !== ContainerStatus.Exited
        && canonical.status !== ContainerStatus.Dead
      )
    ) return null;
    const superseded = await this.workflow
      .supersedePendingForResourceInTransaction(transaction, {
        serverId: container.serverId,
        resourceType: 'container',
        resourceId: container.id,
        reason: 'Canonical desired-running runtime stopped before SSH dispatch',
      });
    if (superseded.length !== 1 || superseded[0] !== active.id) {
      throw new RuntimeDriftFenceConflictError(
        `SSH task ${active.id} lost lifecycle ownership`,
      );
    }
    const activeContainer = (await this.containers.find(
      container.id,
      transaction,
    ))!;
    const restored = await this.containers.transition(
      container.id,
      activeContainer.revision,
      {
        lifecyclePhase: ContainerPhase.Active,
        activeTaskId: null,
        failureReason: null,
        failureCode: null,
      },
      transaction,
    );
    if (!restored) throw new RuntimeDriftFenceConflictError(
      `Container ${container.id} lost SSH recovery fence`,
    );
    return this.schedulePowerRecovery(
      transaction,
      restored,
      canonical,
      dockerRoot,
    );
  }

  private async startRecoveryPayload(
    transaction: Transaction<NyabaseDatabase>,
    container: ContainerAggregate,
    dockerRoot: string,
  ): Promise<{ payload: Record<string, unknown>; resourceKeys: string[] } | null> {
    if (
      !container.boundRuntimeId
      || container.quotaPaths.length !== 2
      || !dockerRoot.trim()
    ) return null;
    const mounts = await resolveContainerMountIntegrity(
      transaction,
      container,
      await this.containers.listMounts([container.id], transaction),
    );
    const quota = await transaction.selectFrom('control.quota_desired')
      .selectAll()
      .where('server_id', '=', container.serverId)
      .where('user_id', '=', container.ownerId)
      .executeTakeFirst();
    if (
      !quota
      || !quota.last_task_id
      || !Number.isSafeInteger(quota.numeric_user_id)
      || quota.generation < 1
      || Number(quota.limit_bytes) < 0
    ) return null;
    const agentMounts: ContainerMountSpec[] = [];
    const resourceKeys = [
      this.resourceKeys.container(container.id),
      this.resourceKeys.quota(container.serverId, container.ownerId),
    ];
    for (const mount of mounts) {
      agentMounts.push({
        sourceId: mount.sourceId,
        resourceId: mount.resourceId,
        sourceIdentity: mount.sourceIdentity,
        containerPath: mount.containerPath,
      });
      resourceKeys.push(
        this.resourceKeys.dataDir({
          serverId: container.serverId,
          sourceKind: mount.sourceKind,
          sourceId: mount.sourceId,
          name: mount.dirName,
        }),
        this.resourceKeys.mountSource({
          serverId: container.serverId,
          sourceKind: mount.sourceKind,
          sourceId: mount.sourceId,
        }),
      );
    }
    return {
      payload: {
        containerId: container.id,
        runtimeId: container.boundRuntimeId,
        dockerRoot,
        quotaGeneration: quota.generation,
        numericOwnerId: quota.numeric_user_id,
        diskBytes: Number(quota.limit_bytes),
        quotaPaths: container.quotaPaths,
        mounts: agentMounts,
      },
      resourceKeys: [...new Set(resourceKeys)].sort(),
    };
  }

  private async markRuntimeMissing(
    transaction: Transaction<NyabaseDatabase>,
    container: ContainerAggregate,
    reported: readonly ContainerSnapshot[],
  ): Promise<void> {
    const observed = reported.map((snapshot) => snapshot.runtime.runtimeId).sort();
    await this.markFailed(
      transaction,
      container,
      'runtime_missing',
      observed.length === 0
        ? `Bound runtime ${container.boundRuntimeId ?? '(none)'} is absent from the authoritative Agent inventory`
        : `No reported runtime matches bound identity ${container.boundRuntimeId ?? '(none)'}; observed ${observed.join(', ')}`,
    );
  }

  private async markFailed(
    transaction: Transaction<NyabaseDatabase>,
    container: ContainerAggregate,
    failureCode: string,
    failureReason: string,
  ): Promise<void> {
    if (!await this.containers.transition(
      container.id,
      container.revision,
      {
        lifecyclePhase: ContainerPhase.Failed,
        activeTaskId: null,
        failureCode,
        failureReason,
      },
      transaction,
    )) throw new RuntimeDriftFenceConflictError(
      `Container ${container.id} lost its failure fence`,
    );
  }

  private async releaseRuntimeClaim(
    transaction: Transaction<NyabaseDatabase>,
    serverId: string,
    runtimeId: string,
  ): Promise<boolean> {
    const claim = (await this.containers.runtimeCleanupClaims(
      serverId,
      transaction,
    )).find((row) =>
      row.ownerId === runtimeId && row.state === 'active');
    if (!claim) return false;
    monotonicReuseGuard.arm(networkClaimReuseKey(claim.id));
    const reusableAt = await this.containers.networkClaimReuseDeadline(
      CONTAINER_DELETE_PROXY_DRAIN_MS,
      transaction,
    );
    return Boolean(await this.containers.markRuntimeCleanupReleasing(
      runtimeId,
      serverId,
      reusableAt,
      transaction,
    ));
  }

  private async gcExpiredClaims(
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    const databaseNow = await this.containers.currentDatabaseTime(transaction);
    const expired = await this.containers.releasedNetworkClaimCandidates(
      databaseNow,
      NETWORK_CLAIM_GC_BATCH,
      transaction,
    );
    for (const claim of expired) {
      if (!monotonicReuseGuard.mayReuse(
        networkClaimReuseKey(claim.id),
        claim.reusableAt,
        databaseNow.getTime(),
      )) continue;
      await this.containers.deleteReleasedNetworkClaim(
        claim.id,
        claim.reusableAt!,
        transaction,
      );
    }
  }

  private isCanonical(
    snapshot: ContainerSnapshot,
    container: ContainerAggregate,
    expectedIp: string | null,
  ): boolean {
    const labels = snapshot.labels ?? {};
    return container.boundRuntimeId === snapshot.runtime.runtimeId
      && expectedIp !== null
      && snapshot.runtime.ip === expectedIp
      && container.runtimeSpecHash !== null
      && container.runtimeSpecHash === labels[LABEL.RUNTIME_SPEC_HASH]
      && labels[LABEL.SPEC_GENERATION]
        === String(container.desiredGeneration);
  }

  private stagedRuntimeId(task: WorkflowTaskRecord): string | null {
    const evidence = this.record(task.agentResult);
    if (!evidence) return null;
    if (evidence.status === 'succeeded') {
      return this.nonEmptyString(this.record(evidence.result)?.runtimeId);
    }
    if (evidence.status !== 'failed') return null;
    const observed = this.record(evidence.observed);
    return this.nonEmptyString(
      this.record(observed?.safetyRollback)?.runtimeId,
    ) ?? this.nonEmptyString(observed?.runtimeId);
  }

  private isUnboundDeleteTask(task: WorkflowTaskRecord): boolean {
    if (task.kind !== AgentTaskKind.ContainerDelete) return false;
    try {
      return (parseAgentTaskPayload(task.kind, task.payload) as {
        runtimeId: string | null;
      }).runtimeId === null;
    } catch {
      return false;
    }
  }

  private canonicalQuotaPaths(
    snapshot: ContainerSnapshot,
    dockerRoot: string,
  ): [string, string] {
    const root = path.resolve(dockerRoot);
    const quotaPaths = snapshot.runtime.quotaPaths;
    if (
      !path.isAbsolute(dockerRoot)
      || root !== dockerRoot
      || quotaPaths.length !== 2
      || new Set(quotaPaths).size !== 2
      || quotaPaths.some((quotaPath) =>
        !path.isAbsolute(quotaPath)
        || path.resolve(quotaPath) !== quotaPath
        || !quotaPath.startsWith(`${root}${path.sep}`))
    ) throw new Error(
      `Runtime ${snapshot.runtime.runtimeId} reported invalid writable-layer recovery paths`,
    );
    return [quotaPaths[0], quotaPaths[1]];
  }

  private cleanupIdentity(payload: ContainerRuntimeAbsentTaskPayload) {
    return {
      runtimeId: payload.runtimeId,
      containerId: payload.containerId,
      serverId: payload.serverId,
      specGeneration: payload.specGeneration,
      runtimeSpecHash: payload.runtimeSpecHash,
      quotaPaths: payload.quotaPaths,
    };
  }

  private isTransitionPhase(phase: ContainerPhase): boolean {
    return phase === ContainerPhase.Provisioning
      || phase === ContainerPhase.Updating
      || phase === ContainerPhase.Deleting;
  }

  private groupByProduct(
    snapshots: readonly ContainerSnapshot[],
  ): Map<string, ContainerSnapshot[]> {
    const result = new Map<string, ContainerSnapshot[]>();
    for (const snapshot of snapshots) {
      const id = this.productId(snapshot);
      const rows = result.get(id) ?? [];
      rows.push(snapshot);
      result.set(id, rows);
    }
    return result;
  }

  private productId(snapshot: ContainerSnapshot): string {
    const value = snapshot.labels?.[LABEL.CONTAINER_ID];
    if (!value) {
      throw new Error(
        'Validated managed runtime is missing its product container id',
      );
    }
    return value;
  }

  private record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  private nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private isQueueFull(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('getResponse' in error)) {
      return false;
    }
    const getResponse = (error as { getResponse?: unknown }).getResponse;
    if (typeof getResponse !== 'function') return false;
    const response = getResponse.call(error);
    return Boolean(
      response
      && typeof response === 'object'
      && (response as { code?: unknown }).code === 'AGENT_TASK_QUEUE_FULL',
    );
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
