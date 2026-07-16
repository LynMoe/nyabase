import { Injectable } from '@nestjs/common';
import * as path from 'node:path';
import { In, IsNull, type EntityManager } from 'typeorm';
import { isDeepStrictEqual } from 'node:util';
import { v4 as uuidv4 } from 'uuid';
import {
  AgentTaskKind,
  AgentTaskStatus,
  canonicalIpv4Address,
  CONTAINER_DELETE_PROXY_DRAIN_MS,
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER,
  ServerStatus,
  LABEL,
  parseAgentTaskPayload,
  type ContainerMountSpec,
  type ContainerRuntimeAbsentTaskPayload,
  type ContainerSnapshot,
} from '@nyabase/common';
import { AgentTasksService } from '../agent-tasks/agent-tasks.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { ResourceLockedException } from '../agent-tasks/resource-lock.service.js';
import {
  monotonicReuseGuard,
  networkClaimReuseKey,
} from '../common/monotonic-reuse-guard.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import type { DataSource } from 'typeorm';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import {
  AGENT_INVENTORY_FAULT_QUARANTINE_CODE,
  ServerEntity,
} from '../entities/server.entity.js';
import {
  assertNetworkClaimCapacity,
  gcExpiredNetworkClaims,
} from '../common/network-claim-ledger.js';

class RuntimeCleanupLedgerCorruptionError extends Error {}

export interface RuntimeDriftReconcileResult {
  taskIds: string[];
  failedContainerIds: string[];
  claimsChanged: boolean;
  quarantineReason: string | null;
}

/**
 * Converts one authoritative full Agent inventory into durable convergence
 * work. The Backend is the sole state machine: the Agent receives only exact,
 * replayable physical effects and keeps no recovery journal.
 */
@Injectable()
export class RuntimeDriftReconcilerService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tasks: AgentTasksService,
    private readonly resourceKeys: ResourceKeyService,
  ) {}

  async reconcile(
    serverId: string,
    snapshots: readonly ContainerSnapshot[],
    dockerRoot: string,
  ): Promise<RuntimeDriftReconcileResult> {
    return runSerializedTransaction(this.dataSource, async (manager) => {
      try {
      await gcExpiredNetworkClaims(manager);
      const claimedIds = [...new Set(snapshots.map((snapshot) => this.productId(snapshot)))];
      const [onServer, claimed] = await Promise.all([
        manager.find(ContainerEntity, { where: { serverId } }),
        claimedIds.length === 0
          ? Promise.resolve([])
          : manager.find(ContainerEntity, { where: { id: In(claimedIds) } }),
      ]);
      const containers = new Map<string, ContainerEntity>();
      for (const container of [...onServer, ...claimed]) containers.set(container.id, container);
      const ids = [...containers.keys()];
      const [lifecycles, desiredSpecs, containerClaims, durableServer] = await Promise.all([
        ids.length === 0
          ? Promise.resolve([])
          : manager.find(ContainerLifecycleEntity, { where: { containerId: In(ids) } }),
        ids.length === 0
          ? Promise.resolve([])
          : manager.find(ContainerDesiredSpecEntity, { where: { containerId: In(ids) } }),
        ids.length === 0
          ? Promise.resolve([])
          : manager.find(NetworkAddressClaimEntity, {
            where: { ownerKind: 'container', ownerId: In(ids), state: 'active' },
          }),
        manager.findOneBy(ServerEntity, { id: serverId }),
      ]);
      if (!durableServer?.macvlanCidr) throw new Error('Server network identity is not bound');
      const lifecycleById = new Map(lifecycles.map((row) => [row.containerId, row]));
      const desiredById = new Map(desiredSpecs.map((row) => [row.containerId, row]));
      const claimByContainerId = new Map(containerClaims.map((claim) => [claim.ownerId, claim]));
      const reportedByProduct = this.groupByProduct(snapshots);
      const taskIds: string[] = [];
      const failedContainerIds: string[] = [];
      let claimsChanged = false;

      for (const [containerId, reported] of [...reportedByProduct.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const container = containers.get(containerId);
        const lifecycle = lifecycleById.get(containerId);
        const belongsHere = Boolean(
          container
          && container.serverId === serverId
          && lifecycle,
        );

        if (!belongsHere) {
          const cleanup = await this.scheduleRuntimeCleanups(
            manager,
            serverId,
            durableServer.macvlanCidr,
            reported,
            dockerRoot,
          );
          claimsChanged ||= cleanup.claimsChanged;
          taskIds.push(...cleanup.taskIds);
          continue;
        }

        // A user/high-level task owns this resource until its finalizer commits.
        // A report observed in that interval must neither guess its canonical
        // runtime nor supersede its durable physical intent. Conversely, a
        // transition phase without an owner cannot make progress and must not
        // remain an implicit forever-busy state.
        if (lifecycle!.activeTaskId) {
          const activeTask = await manager.findOneBy(AgentTaskEntity, { id: lifecycle!.activeTaskId });
          if (!activeTask || activeTask.status !== AgentTaskStatus.Pending) {
            const cleanup = await this.scheduleRuntimeCleanups(
              manager,
              serverId,
              durableServer.macvlanCidr,
              reported,
              dockerRoot,
            );
            claimsChanged ||= cleanup.claimsChanged;
            taskIds.push(...cleanup.taskIds);
            await this.markTransitionOwnerMissing(manager, lifecycle!);
            failedContainerIds.push(containerId);
            continue;
          }
          const taskOwnedRuntimeId = lifecycle!.boundRuntimeId
            ?? this.stagedRuntimeId(activeTask);
          if (!taskOwnedRuntimeId) {
            if (this.isUnboundDeleteTask(activeTask)) {
              // The immutable delete task cannot safely claim success while a
              // product-labelled residual exists. Clean every exact runtime
              // under runtime locks first; the same delete task then replays
              // and freshly proves product absence.
              const cleanup = await this.scheduleRuntimeCleanups(
                manager,
                serverId,
                durableServer.macvlanCidr,
                reported,
                dockerRoot,
              );
              claimsChanged ||= cleanup.claimsChanged;
              taskIds.push(...cleanup.taskIds);
              continue;
            }
            // During create execution no report-side heuristic may guess which
            // duplicate is owned by the in-flight task. Claim every address to
            // prevent reuse; the immutable Agent result chooses the provisional
            // canonical runtime on a later report.
            claimsChanged = await this.ensureRuntimeClaims(
              manager,
              serverId,
              durableServer.macvlanCidr,
              reported,
              dockerRoot,
            ) || claimsChanged;
            continue;
          }
          const taskOwnedSnapshot = reported.find(
            (snapshot) => snapshot.runtime.runtimeId === taskOwnedRuntimeId,
          );
          const extras = reported.filter((snapshot) => snapshot !== taskOwnedSnapshot);
          const exactContainerClaim = claimByContainerId.get(containerId);
          if (
            !taskOwnedSnapshot
            || exactContainerClaim?.address === taskOwnedSnapshot.runtime.ip
          ) {
            // Absence, or presence on the exact durable container address,
            // makes any cleanup-only claims for this runtime obsolete.
            claimsChanged = await this.releaseCanonicalRuntimeClaims(
              manager,
              serverId,
              taskOwnedRuntimeId,
            ) || claimsChanged;
          } else {
            // A staged/bound runtime on a different address is still owned by
            // the high-level task, so do not race it with cleanup. Claim the
            // observed address first and retain every historical claim until
            // the finalizer commits and a later report chooses canonical or
            // cleanup state.
            claimsChanged = await this.ensureRuntimeClaims(
              manager,
              serverId,
              durableServer.macvlanCidr,
              [taskOwnedSnapshot],
              dockerRoot,
            ) || claimsChanged;
          }
          const cleanup = await this.scheduleRuntimeCleanups(
            manager,
            serverId,
            durableServer.macvlanCidr,
            extras,
            dockerRoot,
          );
          claimsChanged ||= cleanup.claimsChanged;
          taskIds.push(...cleanup.taskIds);
          continue;
        }
        if (this.isTransitionPhase(lifecycle!.phase)) {
          const cleanup = await this.scheduleRuntimeCleanups(
            manager,
            serverId,
            durableServer.macvlanCidr,
            reported,
            dockerRoot,
          );
          claimsChanged ||= cleanup.claimsChanged;
          taskIds.push(...cleanup.taskIds);
          await this.markTransitionOwnerMissing(manager, lifecycle!);
          failedContainerIds.push(containerId);
          continue;
        }

        const desired = desiredById.get(containerId);
        if (!desired) {
          const cleanup = await this.scheduleRuntimeCleanups(
            manager,
            serverId,
            durableServer.macvlanCidr,
            reported,
            dockerRoot,
          );
          claimsChanged ||= cleanup.claimsChanged;
          taskIds.push(...cleanup.taskIds);
          if (lifecycle!.phase === ContainerPhase.Active) {
            await this.markFailed(
              manager,
              lifecycle!,
              'runtime_desired_missing',
              'Container desired state is missing during authoritative runtime reconciliation',
            );
            failedContainerIds.push(containerId);
          }
          continue;
        }

        const canonical = reported.find((snapshot) => this.isCanonical(
          snapshot,
          lifecycle!,
          desired,
          claimByContainerId.get(containerId)?.address ?? null,
        ));
        if (canonical) {
          claimsChanged = await this.releaseCanonicalRuntimeClaims(
            manager,
            serverId,
            canonical.runtime.runtimeId,
          ) || claimsChanged;
        }
        const extras = reported.filter((snapshot) => snapshot !== canonical);
        if (extras.length > 0) {
          const cleanup = await this.scheduleRuntimeCleanups(
            manager,
            serverId,
            durableServer.macvlanCidr,
            extras,
            dockerRoot,
          );
          claimsChanged ||= cleanup.claimsChanged;
          taskIds.push(...cleanup.taskIds);
        }

        if (lifecycle!.phase === ContainerPhase.Active && !canonical) {
          await this.markRuntimeMissing(manager, lifecycle!, reported);
          failedContainerIds.push(containerId);
          continue;
        }

        if (
          lifecycle!.phase === ContainerPhase.Active
          && canonical
          && extras.length === 0
        ) {
          const powerRecovery = await this.schedulePowerRecovery(
            manager,
            container!,
            desired,
            lifecycle!,
            canonical,
            dockerRoot,
          );
          if (powerRecovery.taskId) taskIds.push(powerRecovery.taskId);
          if (powerRecovery.failed) failedContainerIds.push(containerId);
        }
      }

      // Absence from a successfully collected full inventory is authoritative.
      // It is never left as an in-memory/UI-only drift flag.
      for (const container of onServer) {
        const lifecycle = lifecycleById.get(container.id);
        if (!lifecycle || lifecycle.activeTaskId || reportedByProduct.has(container.id)) continue;
        if (this.isTransitionPhase(lifecycle.phase)) {
          await this.markTransitionOwnerMissing(manager, lifecycle);
          failedContainerIds.push(container.id);
          continue;
        }
        if (lifecycle.phase !== ContainerPhase.Active) continue;
        if (!desiredById.has(container.id)) {
          await this.markFailed(
            manager,
            lifecycle,
            'runtime_desired_missing',
            'Container desired state is missing during authoritative runtime reconciliation',
          );
        } else {
          await this.markRuntimeMissing(manager, lifecycle, []);
        }
        failedContainerIds.push(container.id);
      }

      const absentCleanupTaskIds = await this.recoverAbsentRuntimeClaims(
        manager,
        serverId,
        snapshots,
      );
      taskIds.push(...absentCleanupTaskIds);

      return {
        taskIds: [...new Set(taskIds)],
        failedContainerIds: [...new Set(failedContainerIds)],
        claimsChanged,
        quarantineReason: null,
      };
      } catch (error) {
        // Only impossible durable/authoritative evidence is an Agent fault.
        // Global ledger pressure is Backend capacity backpressure: bubble it
        // so the socket is retired and a later report can run bounded GC and
        // retry without requiring an administrative quarantine reset.
        if (!(error instanceof RuntimeCleanupLedgerCorruptionError)) throw error;
        await manager.update(ServerEntity, serverId, {
          status: ServerStatus.AgentQuarantined,
          quarantineCode: AGENT_INVENTORY_FAULT_QUARANTINE_CODE,
          quarantineMessage: error.message.slice(0, 2048),
        });
        return {
          taskIds: [],
          failedContainerIds: [],
          // Conservatively revoke all route snapshots after a cleanup-ledger
          // corruption even if this report did not insert a new claim.
          claimsChanged: true,
          quarantineReason: error.message.slice(0, 2048),
        };
      }
    });
  }

  private async scheduleRuntimeCleanups(
    manager: EntityManager,
    serverId: string,
    networkKey: string,
    candidates: readonly ContainerSnapshot[],
    dockerRoot: string,
  ): Promise<{ taskIds: string[]; claimsChanged: boolean }> {
    const sorted = [...candidates]
      .sort((left, right) => left.runtime.runtimeId.localeCompare(right.runtime.runtimeId));
    const claimsChanged = await this.ensureRuntimeClaims(
      manager,
      serverId,
      networkKey,
      sorted,
      dockerRoot,
    );
    return this.scheduleRuntimeCleanupTasks(
      manager,
      serverId,
      sorted,
      dockerRoot,
      claimsChanged,
    );
  }

  private async ensureRuntimeClaims(
    manager: EntityManager,
    serverId: string,
    networkKey: string,
    snapshots: readonly ContainerSnapshot[],
    dockerRoot: string,
  ): Promise<boolean> {
    if (snapshots.length === 0) return false;
    const prepared = snapshots.map((snapshot) => {
      const cleanupPayload = this.runtimeCleanupPayload(snapshot, serverId, dockerRoot);
      return {
        snapshot,
        cleanupPayload,
        address: canonicalIpv4Address(snapshot.runtime.ip),
      };
    });
    const runtimeIds = [...new Set(prepared.map(({ snapshot }) => snapshot.runtime.runtimeId))];
    const addresses = [...new Set(prepared.map(({ address }) => address))];
    const [activeCount, relevant] = await Promise.all([
      manager.count(NetworkAddressClaimEntity, {
        where: { ownerKind: 'runtime_cleanup', serverId, state: 'active' },
      }),
      manager.find(NetworkAddressClaimEntity, {
        where: {
          ownerKind: 'runtime_cleanup',
          ownerId: In(runtimeIds),
          address: In(addresses),
          serverId,
        },
      }),
    ]);
    if (activeCount > MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER) {
      throw new RuntimeCleanupLedgerCorruptionError(
        `Server ${serverId} has ${activeCount} active runtime cleanup claims; maximum is ${MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER}`,
      );
    }
    const existingByIdentity = new Map(relevant.map((claim) => [
      `${claim.ownerId}\0${claim.address}`,
      claim,
    ]));
    const additionalActive = new Set(prepared
      .filter(({ snapshot, address }) =>
        existingByIdentity.get(`${snapshot.runtime.runtimeId}\0${address}`)?.state !== 'active')
      .map(({ snapshot, address }) => `${snapshot.runtime.runtimeId}\0${address}`)).size;
    const additionalRows = new Set(prepared
      .filter(({ snapshot, address }) =>
        !existingByIdentity.has(`${snapshot.runtime.runtimeId}\0${address}`))
      .map(({ snapshot, address }) => `${snapshot.runtime.runtimeId}\0${address}`)).size;
    await assertNetworkClaimCapacity(manager, additionalRows);
    if (activeCount + additionalActive > MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER) {
      throw new RuntimeCleanupLedgerCorruptionError(
        `Server ${serverId} runtime cleanup claim capacity ${MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER} would be exceeded`,
      );
    }

    let changed = false;
    // Address safety is independent of queue admission: every observed runtime
    // gets a durable claim before any cleanup task is attempted.
    for (const { snapshot, cleanupPayload, address } of prepared) {
      const existing = existingByIdentity.get(`${snapshot.runtime.runtimeId}\0${address}`);
      if (!existing) {
        const created = manager.create(NetworkAddressClaimEntity, {
          id: uuidv4(),
          address,
          networkKey,
          ownerKind: 'runtime_cleanup',
          ownerId: snapshot.runtime.runtimeId,
          serverId,
          state: 'active',
          cleanupPayloadJson: cleanupPayload,
          reusableAt: null,
        });
        await manager.save(NetworkAddressClaimEntity, created);
        existingByIdentity.set(`${snapshot.runtime.runtimeId}\0${address}`, created);
        changed = true;
      } else if (existing.networkKey !== networkKey) {
        throw new RuntimeCleanupLedgerCorruptionError(
          `Runtime ${snapshot.runtime.runtimeId} changed network identity`,
        );
      } else if (
        existing.cleanupPayloadJson !== null
        && !isDeepStrictEqual(existing.cleanupPayloadJson, cleanupPayload)
      ) {
        throw new RuntimeCleanupLedgerCorruptionError(
          `Runtime ${snapshot.runtime.runtimeId} changed immutable cleanup evidence`,
        );
      } else if (existing.state !== 'active') {
        await manager.update(NetworkAddressClaimEntity, existing.id, {
          state: 'active',
          cleanupPayloadJson: cleanupPayload,
          reusableAt: null,
        });
        changed = true;
      }
    }
    return changed;
  }

  private async scheduleRuntimeCleanupTasks(
    manager: EntityManager,
    serverId: string,
    sorted: readonly ContainerSnapshot[],
    dockerRoot: string,
    claimsChanged: boolean,
  ): Promise<{ taskIds: string[]; claimsChanged: boolean }> {
    const taskIds: string[] = [];
    for (const snapshot of sorted) {
      const payload = this.runtimeCleanupPayload(snapshot, serverId, dockerRoot);
      const existingTasks = await manager.find(AgentTaskEntity, {
        select: {
          id: true,
          payloadJson: true,
          admissionClass: true,
        },
        where: {
          kind: AgentTaskKind.ContainerRuntimeAbsent,
          serverId,
          resourceType: 'container_runtime',
          resourceId: snapshot.runtime.runtimeId,
          status: AgentTaskStatus.Pending,
        },
        order: { id: 'ASC' },
        take: 2,
      });
      if (existingTasks.length > 1) {
        throw new RuntimeCleanupLedgerCorruptionError(
          `Runtime ${snapshot.runtime.runtimeId} has multiple pending cleanup authorities`,
        );
      }
      const identity = this.cleanupIdentity(payload);
      const existing = existingTasks.find((task) => {
        try {
          const taskPayload = parseAgentTaskPayload(
            AgentTaskKind.ContainerRuntimeAbsent,
            task.payloadJson,
          ) as ContainerRuntimeAbsentTaskPayload;
          return isDeepStrictEqual(this.cleanupIdentity(taskPayload), identity);
        } catch {
          return false;
        }
      });
      if (existing) {
        if (existing.admissionClass !== 'safety') {
          await manager.update(AgentTaskEntity, existing.id, {
            admissionClass: 'safety',
          });
        }
        taskIds.push(existing.id);
        continue;
      }
      try {
        const task = await this.enqueueRuntimeCleanup(manager, serverId, payload, 'safety');
        taskIds.push(task.taskId);
      } catch (error) {
        // Queue pressure is recoverable only while the admitted Agent can
        // drain older bounded safety work. The exact address claim above is
        // retained, and a later report retries enqueue. Quarantining here
        // would prevent the full queue from ever draining.
        if (error instanceof ResourceLockedException || this.isQueueFull(error)) continue;
        throw error;
      }
    }
    return { taskIds, claimsChanged };
  }

  private async enqueueRuntimeCleanup(
    manager: EntityManager,
    serverId: string,
    payload: ContainerRuntimeAbsentTaskPayload,
    admissionClass: 'safety' | 'reconciliation',
  ) {
    return this.tasks.enqueueInTransaction(manager, {
        kind: AgentTaskKind.ContainerRuntimeAbsent,
        serverId,
        resourceType: 'container_runtime',
        resourceId: payload.runtimeId,
        requestedBy: null,
        request: { reason: 'authoritative_state_report_drift' },
        payload,
        // Cleanup owns only the exact physical runtime. The high-level
        // container lock may belong to a staged create finalizer whose success
        // is deliberately waiting for this residual to disappear.
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
    let observedIp: string;
    try {
      observedIp = canonicalIpv4Address(snapshot.runtime.ip);
    } catch {
      throw new RuntimeCleanupLedgerCorruptionError(
        `Runtime ${snapshot.runtime.runtimeId} reported a non-canonical cleanup address`,
      );
    }
    return parseAgentTaskPayload(AgentTaskKind.ContainerRuntimeAbsent, {
      runtimeId: snapshot.runtime.runtimeId,
      containerId: this.productId(snapshot),
      serverId,
      specGeneration: labels[LABEL.SPEC_GENERATION],
      runtimeSpecHash: labels[LABEL.RUNTIME_SPEC_HASH],
      quotaPaths: this.canonicalQuotaPaths(snapshot, dockerRoot),
      observedIp,
    }) as ContainerRuntimeAbsentTaskPayload;
  }

  private async recoverAbsentRuntimeClaims(
    manager: EntityManager,
    serverId: string,
    snapshots: readonly ContainerSnapshot[],
  ): Promise<string[]> {
    const reportedRuntimeIds = new Set(snapshots.map((snapshot) => snapshot.runtime.runtimeId));
    const claims = await manager.find(NetworkAddressClaimEntity, {
      where: {
        ownerKind: 'runtime_cleanup',
        serverId,
        state: 'active',
      },
      order: { ownerId: 'ASC', address: 'ASC' },
      take: MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER + 1,
    });
    if (claims.length > MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER) {
      throw new RuntimeCleanupLedgerCorruptionError(
        `Server ${serverId} exceeds the bounded runtime cleanup claim authority`,
      );
    }
    const byRuntime = new Map<string, NetworkAddressClaimEntity[]>();
    for (const claim of claims) {
      if (reportedRuntimeIds.has(claim.ownerId)) continue;
      const group = byRuntime.get(claim.ownerId) ?? [];
      group.push(claim);
      byRuntime.set(claim.ownerId, group);
    }

    const taskIds: string[] = [];
    for (const [runtimeId, runtimeClaims] of byRuntime) {
      const payloads = runtimeClaims.map((claim) => {
        let payload: ContainerRuntimeAbsentTaskPayload;
        try {
          payload = parseAgentTaskPayload(
            AgentTaskKind.ContainerRuntimeAbsent,
            claim.cleanupPayloadJson,
          ) as ContainerRuntimeAbsentTaskPayload;
        } catch (error) {
          throw new RuntimeCleanupLedgerCorruptionError(
            `Runtime cleanup claim ${claim.id} has invalid cleanup evidence: ${this.errorMessage(error)}`,
          );
        }
        if (
          payload.runtimeId !== runtimeId
          || payload.serverId !== serverId
          || payload.observedIp !== claim.address
        ) {
          throw new RuntimeCleanupLedgerCorruptionError(
            `Runtime cleanup claim ${claim.id} has mismatched immutable evidence`,
          );
        }
        return payload;
      });
      const first = payloads[0]!;
      const identity = this.cleanupIdentity(first);
      if (payloads.some((payload) => !isDeepStrictEqual(this.cleanupIdentity(payload), identity))) {
        throw new RuntimeCleanupLedgerCorruptionError(
          `Runtime ${runtimeId} has conflicting durable cleanup evidence`,
        );
      }
      const pending = await manager.find(AgentTaskEntity, {
        select: {
          id: true,
          payloadJson: true,
          admissionClass: true,
        },
        where: {
          kind: AgentTaskKind.ContainerRuntimeAbsent,
          serverId,
          resourceType: 'container_runtime',
          resourceId: runtimeId,
          status: AgentTaskStatus.Pending,
        },
        order: { id: 'ASC' },
        take: 2,
      });
      if (pending.length > 1) {
        throw new RuntimeCleanupLedgerCorruptionError(
          `Runtime ${runtimeId} has multiple pending cleanup authorities`,
        );
      }
      const existing = pending.find((task) => {
        try {
          const payload = parseAgentTaskPayload(
            AgentTaskKind.ContainerRuntimeAbsent,
            task.payloadJson,
          ) as ContainerRuntimeAbsentTaskPayload;
          return isDeepStrictEqual(this.cleanupIdentity(payload), identity);
        } catch {
          return false;
        }
      });
      if (existing) {
        if (existing.admissionClass === 'safety') {
          await manager.update(AgentTaskEntity, existing.id, {
            admissionClass: 'reconciliation',
          });
        }
        taskIds.push(existing.id);
        continue;
      }
      try {
        const task = await this.enqueueRuntimeCleanup(manager, serverId, first, 'reconciliation');
        taskIds.push(task.taskId);
      } catch (error) {
        if (error instanceof ResourceLockedException || this.isQueueFull(error)) continue;
        throw error;
      }
    }
    return taskIds;
  }

  private cleanupIdentity(payload: ContainerRuntimeAbsentTaskPayload): unknown {
    return {
      runtimeId: payload.runtimeId,
      containerId: payload.containerId,
      serverId: payload.serverId,
      specGeneration: payload.specGeneration,
      runtimeSpecHash: payload.runtimeSpecHash,
      quotaPaths: payload.quotaPaths,
    };
  }

  private stagedRuntimeId(task: AgentTaskEntity): string | null {
    const evidence = this.record(task.agentResultJson);
    if (!evidence) return null;
    if (evidence.status === 'succeeded') {
      return this.nonEmptyString(this.record(evidence.result)?.runtimeId);
    }
    if (evidence.status !== 'failed') return null;
    const observed = this.record(evidence.observed);
    return this.nonEmptyString(this.record(observed?.safetyRollback)?.runtimeId)
      ?? this.nonEmptyString(observed?.runtimeId);
  }

  private isUnboundDeleteTask(task: AgentTaskEntity): boolean {
    if (task.kind !== AgentTaskKind.ContainerDelete) return false;
    try {
      const payload = parseAgentTaskPayload(task.kind, task.payloadJson) as {
        runtimeId: string | null;
      };
      return payload.runtimeId === null;
    } catch {
      // Payload corruption is owned by the dispatcher fail-stop path. Runtime
      // reconciliation must not guess deletion authority from an invalid row.
      return false;
    }
  }

  private async releaseCanonicalRuntimeClaims(
    manager: EntityManager,
    serverId: string,
    runtimeId: string,
  ): Promise<boolean> {
    const claims = await manager.find(NetworkAddressClaimEntity, {
      where: {
        ownerKind: 'runtime_cleanup',
        ownerId: runtimeId,
        serverId,
        state: 'active',
      },
    });
    if (claims.length === 0) return false;
    const reusableAt = new Date(Date.now() + CONTAINER_DELETE_PROXY_DRAIN_MS);
    for (const claim of claims) monotonicReuseGuard.arm(networkClaimReuseKey(claim.id));
    await manager.update(
      NetworkAddressClaimEntity,
      { id: In(claims.map((claim) => claim.id)) },
      { state: 'releasing', reusableAt },
    );
    return true;
  }

  private canonicalQuotaPaths(snapshot: ContainerSnapshot, dockerRoot: string): [string, string] {
    const root = path.resolve(dockerRoot);
    const quotaPaths = snapshot.runtime.quotaPaths;
    if (
      !path.isAbsolute(dockerRoot)
      || root !== dockerRoot
      || quotaPaths.length !== 2
      || new Set(quotaPaths).size !== 2
      || quotaPaths.some((quotaPath) => !path.isAbsolute(quotaPath)
        || path.resolve(quotaPath) !== quotaPath
        || !quotaPath.startsWith(`${root}${path.sep}`))
    ) {
      throw new Error(
        `Runtime ${snapshot.runtime.runtimeId} reported invalid writable-layer recovery paths`,
      );
    }
    return [quotaPaths[0], quotaPaths[1]];
  }

  private async schedulePowerRecovery(
    manager: EntityManager,
    container: ContainerEntity,
    desired: ContainerDesiredSpecEntity,
    lifecycle: ContainerLifecycleEntity,
    canonical: ContainerSnapshot,
    dockerRoot: string,
  ): Promise<{ taskId: string | null; failed: boolean }> {
    const wantsRunning = desired.powerIntent === ContainerPowerIntent.Running;
    const isRunning = canonical.status === ContainerStatus.Running;
    const isStopped = canonical.status === ContainerStatus.Exited
      || canonical.status === ContainerStatus.Dead;
    if (!isRunning && !isStopped) {
      await this.markFailed(
        manager,
        lifecycle,
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
      const start = await this.startRecoveryPayload(manager, container, desired, lifecycle, dockerRoot);
      if (!start) {
        await this.markFailed(
          manager,
          lifecycle,
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
      payload = { containerId: container.id, runtimeId: lifecycle.boundRuntimeId };
    }

    try {
      const task = await this.tasks.enqueueInTransaction(manager, {
        kind,
        serverId: container.serverId,
        resourceType: 'container',
        resourceId: container.id,
        requestedBy: null,
        request: { reason: 'authoritative_state_report_power_recovery' },
        payload,
        resourceKeys,
        admissionClass: 'reconciliation',
        beforeCommit: async (taskManager, context) => {
          await taskManager.update(ContainerLifecycleEntity, container.id, {
            phase: ContainerPhase.Updating,
            activeTaskId: context.taskId,
            lastTransitionAt: new Date(),
            failureReason: null,
            failureCode: null,
          });
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

  private async startRecoveryPayload(
    manager: EntityManager,
    container: ContainerEntity,
    desired: ContainerDesiredSpecEntity,
    lifecycle: ContainerLifecycleEntity,
    dockerRoot: string,
  ): Promise<{ payload: Record<string, unknown>; resourceKeys: string[] } | null> {
    if (!lifecycle.boundRuntimeId || lifecycle.quotaPathsJson.length !== 2 || !dockerRoot.trim()) return null;
    const quota = await manager.findOne(QuotaDesiredEntity, {
      where: { serverId: container.serverId, userId: container.ownerId },
    });
    if (
      !quota
      || !quota.lastTaskId
      || !Number.isSafeInteger(quota.numericUserId)
      || quota.numericUserId === null
      || quota.generation < 1
      || quota.limitBytes < 0
    ) return null;
    const mounts = await manager.find(ContainerMountEntity, {
      where: { serverId: container.serverId, containerId: container.id },
      order: { containerPath: 'ASC' },
    });
    const agentMounts: ContainerMountSpec[] = [];
    const resourceKeys = [
      this.resourceKeys.container(container.id),
      this.resourceKeys.quota(container.serverId, container.ownerId),
    ];
    for (const mount of mounts) {
      const dataDir = await manager.findOne(DataDirectoryEntity, {
        where: {
          sourceKind: mount.sourceKind,
          sourceId: mount.sourceId,
          name: mount.dirName,
          userId: container.ownerId,
          desiredState: 'active',
          ...(mount.sourceKind === 'local'
            ? { serverId: container.serverId }
            : { serverId: IsNull() }),
        },
      });
      if (!dataDir || dataDir.sourceIdentity !== mount.sourceIdentity) return null;
      agentMounts.push({
        sourceId: mount.sourceId,
        resourceId: dataDir.id,
        sourceIdentity: dataDir.sourceIdentity,
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
        runtimeId: lifecycle.boundRuntimeId,
        dockerRoot,
        quotaGeneration: quota.generation,
        numericOwnerId: quota.numericUserId,
        diskBytes: quota.limitBytes,
        quotaPaths: lifecycle.quotaPathsJson,
        mounts: agentMounts,
      },
      resourceKeys: [...new Set(resourceKeys)].sort(),
    };
  }

  private async markRuntimeMissing(
    manager: EntityManager,
    lifecycle: ContainerLifecycleEntity,
    reported: readonly ContainerSnapshot[],
  ): Promise<void> {
    const observed = reported.map((snapshot) => snapshot.runtime.runtimeId).sort();
    await this.markFailed(
      manager,
      lifecycle,
      'runtime_missing',
      observed.length === 0
        ? `Bound runtime ${lifecycle.boundRuntimeId ?? '(none)'} is absent from the authoritative Agent inventory`
        : `No reported runtime matches bound identity ${lifecycle.boundRuntimeId ?? '(none)'}; observed ${observed.join(', ')}`,
    );
  }

  private async markTransitionOwnerMissing(
    manager: EntityManager,
    lifecycle: ContainerLifecycleEntity,
  ): Promise<void> {
    await this.markFailed(
      manager,
      lifecycle,
      'runtime_lifecycle_owner_missing',
      `Container lifecycle is ${lifecycle.phase} but has no active durable task owner`,
    );
  }

  private async markFailed(
    manager: EntityManager,
    lifecycle: ContainerLifecycleEntity,
    failureCode: string,
    failureReason: string,
  ): Promise<void> {
    await manager.update(ContainerLifecycleEntity, lifecycle.containerId, {
      phase: ContainerPhase.Failed,
      activeTaskId: null,
      lastTransitionAt: new Date(),
      failureCode,
      failureReason,
    });
    lifecycle.phase = ContainerPhase.Failed;
    lifecycle.activeTaskId = null;
    lifecycle.failureCode = failureCode;
    lifecycle.failureReason = failureReason;
  }

  private isCanonical(
    snapshot: ContainerSnapshot,
    lifecycle: ContainerLifecycleEntity,
    desired: ContainerDesiredSpecEntity,
    expectedIp: string | null,
  ): boolean {
    const labels = snapshot.labels ?? {};
    return lifecycle.boundRuntimeId === snapshot.runtime.runtimeId
      && expectedIp !== null
      && snapshot.runtime.ip === expectedIp
      && lifecycle.runtimeSpecHash !== null
      && lifecycle.runtimeSpecHash === labels[LABEL.RUNTIME_SPEC_HASH]
      && labels[LABEL.SPEC_GENERATION] === String(desired.generation);
  }

  private isTransitionPhase(phase: ContainerPhase): boolean {
    return phase === ContainerPhase.Provisioning
      || phase === ContainerPhase.Updating
      || phase === ContainerPhase.Deleting;
  }

  private groupByProduct(
    snapshots: readonly ContainerSnapshot[],
  ): Map<string, ContainerSnapshot[]> {
    const grouped = new Map<string, ContainerSnapshot[]>();
    for (const snapshot of snapshots) {
      const id = this.productId(snapshot);
      const entries = grouped.get(id) ?? [];
      entries.push(snapshot);
      grouped.set(id, entries);
    }
    return grouped;
  }

  private productId(snapshot: ContainerSnapshot): string {
    const value = snapshot.labels?.[LABEL.CONTAINER_ID];
    if (!value) throw new Error('Validated managed runtime is missing its product container id');
    return value;
  }

  private record(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  private nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private isQueueFull(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('getResponse' in error)) return false;
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
