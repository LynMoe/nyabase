import {
  AgentTaskKind,
  ContainerStatus,
  LABEL,
  NYABASE_NETWORK,
  zContainerCreateTaskPayload,
  zContainerDeleteTaskPayload,
  zContainerRestartTaskPayload,
  zContainerRuntimeAbsentTaskPayload,
  zContainerSshEnsureTaskPayload,
  zContainerStartTaskPayload,
  zContainerStopTaskPayload,
  isUsableHostInCidr,
  MAX_MANAGED_CONTAINERS_PER_AGENT,
  type ContainerCreateTaskPayload,
  type ContainerSshTaskSpec,
} from '@nyabase/common';
import * as path from 'node:path';
import type { AgentConfig } from '../../config.js';
import type { DataDirsManager } from '../../datadirs/data-dirs.js';
import type { ContainerRuntimeSpec, DockerClient, ResolvedContainerMountSpec } from '../../docker/docker-client.js';
import type { DropbearManager } from '../../dropbear/dropbear-manager.js';
import type { RemoteFsMounter } from '../../fs/remote-fs-mounter.js';
import { normalizeXfsQuotaBytes, type XfsQuotaManager } from '../../quota/xfs-quota.js';
import { IncompleteTaskError, ManagedTaskError, type AgentTaskHandler } from '../task-handler.js';
import { forgetContainerMutex } from './container-mutex.js';
import {
  ContainerMountMismatchError,
  ContainerMountReconciler,
  type ContainerMountObservation,
} from './container-mount-reconciler.js';

type ContainerTaskResult = {
  containerId: string;
  runtimeId: string | null;
  ip?: string;
  runtimeSpecHash?: string;
  startedAt?: string;
  quotaPaths?: string[];
  mounts?: ContainerMountObservation[];
  ssh?: unknown;
};

type RuntimeCleanupPayload = Omit<
  ReturnType<typeof zContainerRuntimeAbsentTaskPayload.parse>,
  'observedIp'
> & { observedIp?: string };
type RuntimeCleanupRuntime = {
  inspect: Awaited<ReturnType<DockerClient['inspectContainer']>>;
  quotaPaths: [string, string];
};

export class ContainerTaskHandler implements AgentTaskHandler<ContainerTaskResult> {
  readonly kinds = [
    AgentTaskKind.ContainerCreate,
    AgentTaskKind.ContainerStart,
    AgentTaskKind.ContainerStop,
    AgentTaskKind.ContainerRestart,
    AgentTaskKind.ContainerDelete,
    AgentTaskKind.ContainerRuntimeAbsent,
    AgentTaskKind.ContainerSshEnsure,
  ] as const;

  private readonly mountReconciler: ContainerMountReconciler;

  constructor(
    private readonly config: AgentConfig,
    private readonly docker: DockerClient,
    private readonly quota: XfsQuotaManager,
    private readonly dropbear: DropbearManager,
    private readonly dataDirs: DataDirsManager,
    private readonly remoteFsMounter: RemoteFsMounter,
  ) {
    this.mountReconciler = new ContainerMountReconciler(docker);
  }

  async ensure(kind: AgentTaskKind, payload: unknown): Promise<ContainerTaskResult> {
    switch (kind) {
      case AgentTaskKind.ContainerCreate:
        return this.ensureCreate(zContainerCreateTaskPayload.parse(payload));
      case AgentTaskKind.ContainerStart:
        return this.ensureStarted(zContainerStartTaskPayload.parse(payload));
      case AgentTaskKind.ContainerStop:
        return this.ensureStopped(zContainerStopTaskPayload.parse(payload));
      case AgentTaskKind.ContainerRestart:
        return this.ensureRestarted(zContainerRestartTaskPayload.parse(payload));
      case AgentTaskKind.ContainerDelete:
        return this.ensureDeleted(zContainerDeleteTaskPayload.parse(payload));
      case AgentTaskKind.ContainerRuntimeAbsent:
        return this.ensureRuntimeAbsent(zContainerRuntimeAbsentTaskPayload.parse(payload));
      case AgentTaskKind.ContainerSshEnsure: {
        const parsed = zContainerSshEnsureTaskPayload.parse(payload);
        const runtimeId = await this.requireRuntime(parsed.containerId, parsed.runtimeId);
        return this.withStopOnConvergenceFailure(parsed.containerId, runtimeId, async () => {
          const before = await this.docker.inspectContainer(runtimeId);
          if (!before.State.Running) {
            this.managed(
              'container_ssh_runtime_stopped',
              `Container ${parsed.containerId} is stopped before SSH convergence`,
              { ...this.runtimeObservation(before), applied: false },
            );
          }
          const ssh = await this.ensureSsh(runtimeId, parsed);
          return { containerId: parsed.containerId, runtimeId, ssh };
        });
      }
      default:
        throw new Error(`Unsupported container task kind ${kind}`);
    }
  }

  async verify(kind: AgentTaskKind, payload: unknown, result: ContainerTaskResult): Promise<void> {
    switch (kind) {
      case AgentTaskKind.ContainerCreate: {
        const parsed = zContainerCreateTaskPayload.parse(payload);
        const runtimeId = await this.requireRuntime(parsed.containerId, result.runtimeId ?? undefined);
        await this.withStopOnConvergenceFailure(parsed.containerId, runtimeId, async () => {
          const mounts = await this.resolveMountSpecs(parsed.mounts);
          await this.validateCreateRuntime(parsed, runtimeId, mounts);
          await this.verifyRunning(runtimeId);
          await this.verifyMounts(runtimeId, mounts);
          if (parsed.ssh) await this.verifySsh(runtimeId, parsed.ssh);
          await this.verifyQuotaLimit(parsed.numericOwnerId, parsed.diskBytes);
          await this.verifyWritableLayerQuota(
            parsed.containerId,
            runtimeId,
            parsed.dockerRoot,
            parsed.numericOwnerId,
            result.quotaPaths ?? [],
          );
        });
        return;
      }
      case AgentTaskKind.ContainerStart: {
        const parsed = zContainerStartTaskPayload.parse(payload);
        const runtimeId = await this.requireRuntime(parsed.containerId, parsed.runtimeId);
        await this.withStopOnConvergenceFailure(parsed.containerId, runtimeId, async () => {
          const mounts = await this.resolveMountSpecs(parsed.mounts);
          await this.verifyWritableLayerQuota(
            parsed.containerId,
            runtimeId,
            parsed.dockerRoot,
            parsed.numericOwnerId,
            parsed.quotaPaths,
          );
          await this.verifyQuotaLimit(parsed.numericOwnerId, parsed.diskBytes);
          await this.verifyRunning(runtimeId);
          await this.verifyMounts(runtimeId, mounts);
          if (parsed.ssh) await this.verifySsh(runtimeId, parsed.ssh);
        });
        return;
      }
      case AgentTaskKind.ContainerStop: {
        const parsed = zContainerStopTaskPayload.parse(payload);
        const runtimeId = await this.requireRuntime(parsed.containerId, parsed.runtimeId);
        const inspect = await this.docker.inspectContainer(runtimeId);
        if (inspect.State.Running) {
          this.incomplete('container_not_stopped', `Container ${parsed.containerId} is still running`, this.runtimeObservation(inspect));
        }
        return;
      }
      case AgentTaskKind.ContainerRestart: {
        const parsed = zContainerRestartTaskPayload.parse(payload);
        const runtimeId = await this.requireRuntime(parsed.containerId, parsed.runtimeId);
        await this.withStopOnConvergenceFailure(parsed.containerId, runtimeId, async () => {
          const mounts = await this.resolveMountSpecs(parsed.mounts);
          await this.verifyWritableLayerQuota(
            parsed.containerId,
            runtimeId,
            parsed.dockerRoot,
            parsed.numericOwnerId,
            parsed.quotaPaths,
          );
          await this.verifyQuotaLimit(parsed.numericOwnerId, parsed.diskBytes);
          const inspect = await this.docker.inspectContainer(runtimeId);
          if (!inspect.State.Running || !this.startedChanged(inspect.State.StartedAt, parsed.baselineStartedAt)) {
            this.managed('container_not_restarted', `Container ${parsed.containerId} did not cross its restart baseline`, {
              ...this.runtimeObservation(inspect),
              baselineStartedAt: parsed.baselineStartedAt,
            });
          }
          await this.verifyMounts(runtimeId, mounts);
          if (parsed.ssh) await this.verifySsh(runtimeId, parsed.ssh);
        });
        return;
      }
      case AgentTaskKind.ContainerDelete: {
        const parsed = zContainerDeleteTaskPayload.parse(payload);
        const runtimeId = await this.resolveRuntimeId(parsed.containerId, parsed.runtimeId ?? undefined);
        if (runtimeId) {
          const inspect = await this.docker.inspectContainer(runtimeId);
          this.incomplete('container_not_deleted', `Container ${parsed.containerId} still exists`, this.runtimeObservation(inspect));
        }
        for (const quotaPath of new Set([...(parsed.quotaPaths ?? []), ...(result.quotaPaths ?? [])])) {
          if (this.quota.isPathRegisteredToProject(parsed.numericOwnerId, quotaPath)) {
            this.incomplete('container_quota_registration_stale', `Quota registration remains for ${quotaPath}`, {
              containerId: parsed.containerId,
              runtimeId: null,
              quotaPath,
              registered: true,
            });
          }
        }
        return;
      }
      case AgentTaskKind.ContainerRuntimeAbsent: {
        const parsed = zContainerRuntimeAbsentTaskPayload.parse(payload);
        this.assertRuntimeCleanupPayload(parsed);
        const observed = await this.inspectMaybe(parsed.runtimeId);
        if (observed) {
          this.assertRuntimeCleanupIdentity(parsed, observed, true);
          this.incomplete(
            'container_runtime_cleanup_incomplete',
            `Unexpected runtime ${parsed.runtimeId} still exists`,
            this.runtimeCleanupObservation(observed),
          );
        }
        await this.assertNoRuntimeReferencesCleanupPaths(parsed, true);
        for (const quotaPath of parsed.quotaPaths) {
          let registration;
          try {
            registration = this.quota.inspectExactPathRegistration(quotaPath);
          } catch (error) {
            this.incomplete(
              'container_runtime_cleanup_registration_unobservable',
              `Cannot verify exact XFS registration absence for ${quotaPath}`,
              { ...this.runtimeCleanupExpected(parsed), quotaPath, cause: this.errorMessage(error) },
            );
          }
          if (registration.projectId !== null) {
            this.incomplete(
              'container_runtime_cleanup_registration_stale',
              `Exact XFS registration remains for ${quotaPath}`,
              { ...this.runtimeCleanupExpected(parsed), registration },
            );
          }
        }
        return;
      }
      case AgentTaskKind.ContainerSshEnsure: {
        const parsed = zContainerSshEnsureTaskPayload.parse(payload);
        const runtimeId = await this.requireRuntime(parsed.containerId, parsed.runtimeId);
        await this.withStopOnConvergenceFailure(parsed.containerId, runtimeId, () => this.verifySsh(runtimeId, parsed));
        return;
      }
    }
  }

  private async ensureCreate(payload: ContainerCreateTaskPayload): Promise<ContainerTaskResult> {
    this.assertDockerRoot(payload.containerId, payload.dockerRoot);
    // Probe identity before any quota or Docker effect. This makes a duplicate
    // label a terminal, observable failure instead of selecting an arbitrary
    // runtime and mutating it.
    let runtimeId = await this.resolveRuntimeId(payload.containerId, undefined, payload);
    if (!runtimeId) {
      try {
        if (
          !isUsableHostInCidr(this.config.macvlanCidr, payload.assignedIp)
          || payload.assignedIp === this.config.macvlanGateway
          || this.config.reservedIps.includes(payload.assignedIp)
        ) {
          throw new Error(`Backend-assigned IP ${payload.assignedIp} is outside this Agent's usable address pool`);
        }
        const inventory = await this.docker.listNyabaseContainers();
        if (inventory.length >= MAX_MANAGED_CONTAINERS_PER_AGENT) {
          throw new ManagedTaskError({
            code: 'managed_container_capacity_reached',
            message: `Agent already owns ${MAX_MANAGED_CONTAINERS_PER_AGENT} managed runtimes`,
          }, { containerId: payload.containerId, present: false, applied: false });
        }
        const ipOwner = inventory.find((candidate) => Object.values(
          candidate.NetworkSettings?.Networks ?? {},
        ).some((network) => network?.IPAddress === payload.assignedIp));
        if (ipOwner) {
          throw new ManagedTaskError({
            code: 'assigned_ip_already_in_use',
            message: `Backend-assigned IP ${payload.assignedIp} is already used by runtime ${ipOwner.Id}`,
          }, { containerId: payload.containerId, present: false, applied: false });
        }
        const mounts = await this.resolveMountSpecs(payload.mounts);
        runtimeId = await this.docker.createContainer(
          this.runtimeSpec(payload, payload.assignedIp, mounts),
        );
      } catch (error) {
        // A settled Docker create error may still have crossed the daemon
        // boundary. Fresh exact identity observation decides whether to resume
        // that runtime or terminate as a proved no-effect failure.
        const recovered = await this.resolveRuntimeId(payload.containerId, undefined, payload);
        if (recovered) runtimeId = recovered;
        else {
          const taskError = error instanceof ManagedTaskError || error instanceof IncompleteTaskError
            ? error.taskError
            : {
              code: 'container_create_failed',
              message: `Container ${payload.containerId} could not be created`,
              details: { cause: this.errorMessage(error) },
            };
          throw new ManagedTaskError(taskError, {
            containerId: payload.containerId,
            present: false,
            applied: false,
          });
        }
      }
    }

    let recoveryQuotaPaths: string[] = [];
    try {
      return await this.withStopOnConvergenceFailure(payload.containerId, runtimeId, async () => {
        const expectedMounts = await this.resolveMountSpecs(payload.mounts);
        const identity = await this.validateCreateRuntime(payload, runtimeId, expectedMounts);
        // The user limit and writable-layer project assignments must exist
        // before the first user process can run. Replays also stop a previously
        // running partial create if quota convergence cannot be re-proven.
        await this.ensureQuotaLimit(payload.numericOwnerId, payload.diskBytes);

        const graph = await this.docker.getGraphDriverDirs(runtimeId);
        if (!graph.upperDir || !graph.workDir) {
          this.managed('container_quota_paths_unobservable', `Docker writable layer paths are unavailable for ${runtimeId}`, {
            ...await this.createRuntimeObservation(payload, await this.docker.inspectContainer(runtimeId)),
            graph,
          });
        }
        const quotaPaths = [graph.upperDir, graph.workDir];
        this.assertQuotaPaths(payload.containerId, payload.dockerRoot, quotaPaths);
        recoveryQuotaPaths = quotaPaths;
        for (const quotaPath of quotaPaths) {
          await this.assignQuotaPath(payload.containerId, runtimeId, payload.numericOwnerId, quotaPath);
        }

        const mounts = await this.ensureMounts(runtimeId, expectedMounts);
        const beforeStart = await this.docker.inspectContainer(runtimeId);
        if (!beforeStart.State.Running) {
          await this.assertMountSourcesReady(payload.mounts);
          await this.startOrObserve(payload.containerId, runtimeId);
        }
        const ssh = payload.ssh ? await this.ensureSsh(runtimeId, payload.ssh) : undefined;
        await this.validateCreateRuntime(payload, runtimeId, expectedMounts);
        return {
          containerId: payload.containerId,
          runtimeId,
          ip: identity.ip,
          runtimeSpecHash: identity.runtimeSpecHash,
          quotaPaths,
          mounts,
          ...(ssh === undefined ? {} : { ssh }),
        };
      });
    } catch (error) {
      if (error instanceof ManagedTaskError) {
        if (recoveryQuotaPaths.length !== 2) {
          try {
            const graph = await this.docker.getGraphDriverDirs(runtimeId);
            if (graph.upperDir && graph.workDir) {
              const observedPaths = [graph.upperDir, graph.workDir];
              this.assertQuotaPaths(payload.containerId, payload.dockerRoot, observedPaths);
              recoveryQuotaPaths = observedPaths;
            }
          } catch (recoveryError) {
            throw new IncompleteTaskError({
              code: 'container_create_recovery_metadata_unobservable',
              message: `Container ${payload.containerId} is stopped but its delete recovery metadata is not observable`,
              details: {
                runtimeId,
                convergenceError: error.taskError,
                recoveryError: this.errorMessage(recoveryError),
              },
            });
          }
        }
        if (recoveryQuotaPaths.length !== 2) {
          throw new IncompleteTaskError({
            code: 'container_create_recovery_metadata_unobservable',
            message: `Container ${payload.containerId} is stopped but its delete recovery metadata is incomplete`,
            details: { runtimeId, convergenceError: error.taskError },
          });
        }
        throw new ManagedTaskError(error.taskError, {
          ...error.observed,
          quotaPaths: recoveryQuotaPaths,
        });
      }
      throw error;
    }
  }

  private async ensureStarted(
    payload: ReturnType<typeof zContainerStartTaskPayload.parse>,
  ): Promise<ContainerTaskResult> {
    const runtimeId = await this.requireRuntime(payload.containerId, payload.runtimeId);
    return this.withStopOnConvergenceFailure(payload.containerId, runtimeId, async () => {
      const expectedMounts = await this.resolveMountSpecs(payload.mounts);
      await this.ensureWritableLayerQuota(
        payload.containerId,
        runtimeId,
        payload.dockerRoot,
        payload.numericOwnerId,
        payload.quotaPaths,
      );
      await this.ensureQuotaLimit(payload.numericOwnerId, payload.diskBytes);
      const before = await this.docker.inspectContainer(runtimeId);
      const mounts = await this.ensureMounts(runtimeId, expectedMounts);
      if (!before.State.Running) {
        await this.assertMountSourcesReady(payload.mounts);
        await this.startOrObserve(payload.containerId, runtimeId);
      }
      const ssh = payload.ssh ? await this.ensureSsh(runtimeId, payload.ssh) : undefined;
      const after = await this.docker.inspectContainer(runtimeId);
      return {
        containerId: payload.containerId,
        runtimeId,
        startedAt: after.State.StartedAt,
        mounts,
        ...(ssh === undefined ? {} : { ssh }),
      };
    });
  }

  private async ensureStopped(
    payload: ReturnType<typeof zContainerStopTaskPayload.parse>,
  ): Promise<ContainerTaskResult> {
    const runtimeId = await this.requireRuntime(payload.containerId, payload.runtimeId);
    const inspect = await this.docker.inspectContainer(runtimeId);
    if (inspect.State.Running) {
      try {
        await this.docker.stopContainer(runtimeId, payload.timeoutSeconds);
      } catch (error) {
        const observed = await this.docker.inspectContainer(runtimeId);
        if (observed.State.Running) {
          this.managed('container_stop_failed', `Container ${payload.containerId} could not be stopped`, {
            ...this.runtimeObservation(observed),
            applied: false,
            cause: this.errorMessage(error),
          });
        }
      }
    }
    const after = await this.docker.inspectContainer(runtimeId);
    return { containerId: payload.containerId, runtimeId, startedAt: after.State.StartedAt };
  }

  private async ensureRestarted(
    payload: ReturnType<typeof zContainerRestartTaskPayload.parse>,
  ): Promise<ContainerTaskResult> {
    const runtimeId = await this.requireRuntime(payload.containerId, payload.runtimeId);
    return this.withStopOnConvergenceFailure(payload.containerId, runtimeId, async () => {
      const expectedMounts = await this.resolveMountSpecs(payload.mounts);
      await this.ensureWritableLayerQuota(
        payload.containerId,
        runtimeId,
        payload.dockerRoot,
        payload.numericOwnerId,
        payload.quotaPaths,
      );
      await this.ensureQuotaLimit(payload.numericOwnerId, payload.diskBytes);
      // Docker bind mounts are immutable. Prove the exact source/destination
      // set before restart so a drifted runtime never executes even briefly
      // with the wrong host data attached.
      const mounts = await this.ensureMounts(runtimeId, expectedMounts);
      let inspect = await this.docker.inspectContainer(runtimeId);
      if (!inspect.State.Running || !this.startedChanged(inspect.State.StartedAt, payload.baselineStartedAt)) {
        await this.assertMountSourcesReady(payload.mounts);
        try {
          await this.docker.restartContainer(runtimeId, payload.timeoutSeconds);
        } catch (error) {
          inspect = await this.docker.inspectContainer(runtimeId);
          if (!inspect.State.Running || !this.startedChanged(inspect.State.StartedAt, payload.baselineStartedAt)) {
            this.incomplete('container_restart_incomplete', `Container ${payload.containerId} has not crossed its restart baseline yet`, {
              ...this.runtimeObservation(inspect),
              baselineStartedAt: payload.baselineStartedAt,
              cause: this.errorMessage(error),
            });
          }
        }
        inspect = await this.docker.inspectContainer(runtimeId);
        if (!inspect.State.Running || !this.startedChanged(inspect.State.StartedAt, payload.baselineStartedAt)) {
          this.managed('container_restart_no_effect', `Container ${payload.containerId} restart did not advance StartedAt`, {
            ...this.runtimeObservation(inspect),
            baselineStartedAt: payload.baselineStartedAt,
          });
        }
      }
      await this.assertMountSourcesReady(payload.mounts);
      await this.verifyMounts(runtimeId, expectedMounts);
      const ssh = payload.ssh ? await this.ensureSsh(runtimeId, payload.ssh) : undefined;
      return {
        containerId: payload.containerId,
        runtimeId,
        startedAt: inspect.State.StartedAt,
        mounts,
        ...(ssh === undefined ? {} : { ssh }),
      };
    });
  }

  private async ensureDeleted(
    payload: ReturnType<typeof zContainerDeleteTaskPayload.parse>,
  ): Promise<ContainerTaskResult> {
    if (payload.runtimeId === null) {
      const matches = (await this.docker.listNyabaseContainers())
        .filter((container) => container.Labels?.[LABEL.CONTAINER_ID] === payload.containerId);
      if (matches.length > 0) {
        this.incomplete(
          'container_delete_unbound_runtime_present',
          `Unbound container ${payload.containerId} still has managed Docker runtimes`,
          {
            containerId: payload.containerId,
            expectedRuntimeId: null,
            runtimeIds: matches.slice(0, MAX_MANAGED_CONTAINERS_PER_AGENT)
              .map((container) => container.Id),
          },
        );
      }
      return { containerId: payload.containerId, runtimeId: null, quotaPaths: [] };
    }
    const runtimeId = await this.resolveRuntimeId(payload.containerId, payload.runtimeId);
    if (runtimeId && runtimeId !== payload.runtimeId) {
      this.incomplete(
        'container_delete_runtime_changed',
        `Container ${payload.containerId} runtime changed before deletion`,
        { containerId: payload.containerId, expectedRuntimeId: payload.runtimeId, runtimeId },
      );
    }
    return this.ensureRuntimeAbsent({
      runtimeId: payload.runtimeId,
      containerId: payload.containerId,
      serverId: payload.serverId,
      specGeneration: payload.specGeneration!,
      runtimeSpecHash: payload.runtimeSpecHash!,
      quotaPaths: payload.quotaPaths as [string, string],
    }, this.quota.projectIdForUser(payload.numericOwnerId));
  }

  private async ensureRuntimeAbsent(
    payload: RuntimeCleanupPayload,
    expectedProjectId?: number,
  ): Promise<ContainerTaskResult> {
    this.assertRuntimeCleanupPayload(payload);
    let mutated = false;
    let observed = await this.observeRuntimeCleanup(payload, false);
    if (!observed) return this.completeAbsentRuntimeCleanup(payload, mutated, expectedProjectId);

    // Detect ambiguous registrations before stopping a workload. This keeps
    // every deterministic registry conflict a terminal, proved no-touch
    // failure instead of leaving an avoidable stopped residual runtime.
    this.preflightRuntimeCleanupRegistrations(payload, expectedProjectId);

    if (observed.inspect.State.Running) {
      let stopError: unknown;
      try {
        await this.docker.stopContainer(payload.runtimeId);
      } catch (error) {
        stopError = error;
      }
      mutated = true; // a crossed Docker mutation boundary is never assumed no-op
      observed = await this.observeRuntimeCleanup(payload, true);
      if (!observed) return this.completeAbsentRuntimeCleanup(payload, mutated, expectedProjectId);
      if (observed.inspect.State.Running) {
        this.incomplete(
          'container_runtime_cleanup_stop_incomplete',
          `Unexpected runtime ${payload.runtimeId} is still running after stop`,
          {
            ...this.runtimeCleanupExpected(payload),
            ...this.runtimeCleanupObservation(observed.inspect),
            ...(stopError === undefined ? {} : { cause: this.errorMessage(stopError) }),
          },
        );
      }
    }

    observed = await this.observeRuntimeCleanup(payload, mutated);
    if (!observed) return this.completeAbsentRuntimeCleanup(payload, mutated, expectedProjectId);
    if (observed.inspect.State.Running) {
      this.incomplete(
        'container_runtime_cleanup_stop_incomplete',
        `Unexpected runtime ${payload.runtimeId} is not proved stopped`,
        { ...this.runtimeCleanupExpected(payload), ...this.runtimeCleanupObservation(observed.inspect) },
      );
    }

    // The exact identity and writable-layer paths are re-proved immediately
    // before Docker removal. Registration cleanup only happens after Docker
    // absence and a stable all-runtime path-exclusivity proof.
    observed = await this.observeRuntimeCleanup(payload, true);
    if (!observed) return this.completeAbsentRuntimeCleanup(payload, true, expectedProjectId);
    if (observed.inspect.State.Running) {
      this.incomplete(
        'container_runtime_cleanup_stop_incomplete',
        `Unexpected runtime ${payload.runtimeId} resumed before removal`,
        { ...this.runtimeCleanupExpected(payload), ...this.runtimeCleanupObservation(observed.inspect) },
      );
    }

    let removeError: unknown;
    try {
      await this.docker.removeContainer(payload.runtimeId, false);
    } catch (error) {
      removeError = error;
    }
    mutated = true;
    observed = await this.observeRuntimeCleanup(payload, true);
    if (observed) {
      this.incomplete(
        'container_runtime_cleanup_remove_incomplete',
        `Unexpected runtime ${payload.runtimeId} still exists after removal`,
        {
          ...this.runtimeCleanupExpected(payload),
          ...this.runtimeCleanupObservation(observed.inspect),
          ...(removeError === undefined ? {} : { cause: this.errorMessage(removeError) }),
        },
      );
    }

    return this.completeAbsentRuntimeCleanup(payload, mutated, expectedProjectId);
  }

  private assertRuntimeCleanupPayload(payload: RuntimeCleanupPayload): void {
    if (payload.serverId !== this.config.serverId) {
      this.managed(
        'container_runtime_cleanup_server_mismatch',
        `Runtime cleanup for ${payload.runtimeId} targets another Agent`,
        {
          ...this.runtimeCleanupExpected(payload),
          actualServerId: this.config.serverId,
          present: false,
          applied: false,
        },
      );
    }
    if (this.validRuntimeCleanupPaths(payload.quotaPaths)) return;
    this.managed(
      'container_runtime_cleanup_paths_invalid',
      `Runtime cleanup for ${payload.runtimeId} has invalid writable-layer paths`,
      {
        ...this.runtimeCleanupExpected(payload),
        dockerRoot: this.config.dockerRoot,
        present: false,
        applied: false,
      },
    );
  }

  private async observeRuntimeCleanup(
    payload: RuntimeCleanupPayload,
    afterEffect: boolean,
  ): Promise<RuntimeCleanupRuntime | null> {
    let first;
    try {
      first = await this.inspectMaybe(payload.runtimeId);
    } catch (error) {
      this.incomplete(
        'container_runtime_cleanup_observation_unavailable',
        `Cannot inspect unexpected runtime ${payload.runtimeId}`,
        { ...this.runtimeCleanupExpected(payload), cause: this.errorMessage(error) },
      );
    }
    if (!first) return null;
    this.assertRuntimeCleanupIdentity(payload, first, afterEffect);
    const firstPaths = await this.observeRuntimeCleanupPaths(payload, first, afterEffect);

    let confirmed;
    try {
      confirmed = await this.inspectMaybe(payload.runtimeId);
    } catch (error) {
      this.incomplete(
        'container_runtime_cleanup_observation_unavailable',
        `Cannot confirm unexpected runtime ${payload.runtimeId}`,
        { ...this.runtimeCleanupExpected(payload), cause: this.errorMessage(error) },
      );
    }
    if (!confirmed) return null;
    this.assertRuntimeCleanupIdentity(payload, confirmed, afterEffect);
    const confirmedPaths = await this.observeRuntimeCleanupPaths(payload, confirmed, afterEffect);
    if (firstPaths[0] !== confirmedPaths[0] || firstPaths[1] !== confirmedPaths[1]) {
      this.failRuntimeCleanupClosed(
        payload,
        afterEffect,
        'container_runtime_cleanup_paths_changed',
        `Runtime ${payload.runtimeId} writable-layer paths changed during observation`,
        {
          firstPaths,
          confirmedPaths,
          ...this.runtimeCleanupObservation(confirmed),
        },
      );
    }
    return { inspect: confirmed, quotaPaths: confirmedPaths };
  }

  private async observeRuntimeCleanupPaths(
    payload: RuntimeCleanupPayload,
    inspect: Awaited<ReturnType<DockerClient['inspectContainer']>>,
    afterEffect: boolean,
  ): Promise<[string, string]> {
    let graph;
    try {
      graph = await this.docker.getGraphDriverDirs(payload.runtimeId, inspect);
    } catch (error) {
      this.incomplete(
        'container_runtime_cleanup_paths_unobservable',
        `Cannot inspect writable-layer paths for ${payload.runtimeId}`,
        {
          ...this.runtimeCleanupExpected(payload),
          ...this.runtimeCleanupObservation(inspect),
          cause: this.errorMessage(error),
        },
      );
    }
    const observedPaths: [string, string] = [graph.upperDir, graph.workDir];
    if (!this.validRuntimeCleanupPaths(observedPaths)) {
      this.failRuntimeCleanupClosed(
        payload,
        afterEffect,
        'container_runtime_cleanup_paths_unobservable',
        `Runtime ${payload.runtimeId} has invalid writable-layer paths`,
        { ...this.runtimeCleanupObservation(inspect), observedPaths },
      );
    }
    if (
      observedPaths[0] !== payload.quotaPaths[0]
      || observedPaths[1] !== payload.quotaPaths[1]
    ) {
      this.failRuntimeCleanupClosed(
        payload,
        afterEffect,
        'container_runtime_cleanup_paths_mismatch',
        `Runtime ${payload.runtimeId} writable-layer paths no longer match the authoritative report`,
        { ...this.runtimeCleanupObservation(inspect), observedPaths },
      );
    }
    return observedPaths;
  }

  private async completeAbsentRuntimeCleanup(
    payload: RuntimeCleanupPayload,
    afterEffect: boolean,
    expectedProjectId?: number,
  ): Promise<ContainerTaskResult> {
    await this.assertNoRuntimeReferencesCleanupPaths(payload, afterEffect);
    const mutated = await this.scrubRuntimeCleanupRegistrations(payload, afterEffect, expectedProjectId);
    await this.assertNoRuntimeReferencesCleanupPaths(payload, mutated);
    await this.verifyRuntimeCleanupRegistrationsAbsent(payload);
    forgetContainerMutex(payload.runtimeId);
    return {
      containerId: payload.containerId,
      runtimeId: null,
      quotaPaths: [...payload.quotaPaths],
    };
  }

  private preflightRuntimeCleanupRegistrations(
    payload: RuntimeCleanupPayload,
    expectedProjectId?: number,
  ): void {
    for (const quotaPath of payload.quotaPaths) {
      let registration;
      try {
        registration = this.quota.inspectExactPathRegistration(quotaPath);
      } catch (error) {
        this.incomplete(
          'container_runtime_cleanup_registration_ambiguous',
          `Exact XFS registration for ${quotaPath} is ambiguous`,
          { ...this.runtimeCleanupExpected(payload), quotaPath, cause: this.errorMessage(error) },
        );
      }
      if (
        expectedProjectId !== undefined
        && registration.projectId !== null
        && registration.projectId !== expectedProjectId
      ) {
        this.incomplete(
          'container_runtime_cleanup_registration_owner_mismatch',
          `Exact XFS registration for ${quotaPath} belongs to another project`,
          { ...this.runtimeCleanupExpected(payload), registration, expectedProjectId },
        );
      }
    }
  }

  private async scrubRuntimeCleanupRegistrations(
    payload: RuntimeCleanupPayload,
    afterEffect: boolean,
    expectedProjectId?: number,
  ): Promise<boolean> {
    let mutated = afterEffect;
    this.preflightRuntimeCleanupRegistrations(payload, expectedProjectId);
    for (const quotaPath of payload.quotaPaths) {
      await this.assertNoRuntimeReferencesCleanupPaths(payload, mutated);

      let registration;
      try {
        registration = this.quota.inspectExactPathRegistration(quotaPath);
        if (
          expectedProjectId !== undefined
          && registration.projectId !== null
          && registration.projectId !== expectedProjectId
        ) {
          this.incomplete(
            'container_runtime_cleanup_registration_owner_mismatch',
            `Exact XFS registration for ${quotaPath} changed owner before cleanup`,
            { ...this.runtimeCleanupExpected(payload), registration, expectedProjectId },
          );
        }
        if (registration.projectId !== null) {
          this.quota.removeExactPathRegistration(quotaPath);
          mutated = true;
        }
      } catch (error) {
        let residual: unknown = null;
        try {
          residual = this.quota.inspectExactPathRegistration(quotaPath);
        } catch (probeError) {
          residual = { unobservable: true, cause: this.errorMessage(probeError) };
        }
        this.incomplete(
          'container_runtime_cleanup_registration_incomplete',
          `Cannot prove exact XFS registration absence for ${quotaPath}`,
          {
            ...this.runtimeCleanupExpected(payload),
            quotaPath,
            registration,
            residual,
            cause: this.errorMessage(error),
          },
        );
      }
      let confirmed;
      try {
        confirmed = this.quota.inspectExactPathRegistration(quotaPath);
      } catch (error) {
        this.incomplete(
          'container_runtime_cleanup_registration_unobservable',
          `Cannot confirm exact XFS registration absence for ${quotaPath}`,
          { ...this.runtimeCleanupExpected(payload), quotaPath, cause: this.errorMessage(error) },
        );
      }
      if (confirmed.projectId !== null) {
        this.incomplete(
          'container_runtime_cleanup_registration_incomplete',
          `Exact XFS registration remains for ${quotaPath}`,
          { ...this.runtimeCleanupExpected(payload), registration: confirmed },
        );
      }
    }
    return mutated;
  }

  private async verifyRuntimeCleanupRegistrationsAbsent(payload: RuntimeCleanupPayload): Promise<void> {
    for (const quotaPath of payload.quotaPaths) {
      let observed;
      try {
        observed = this.quota.inspectExactPathRegistration(quotaPath);
      } catch (error) {
        this.incomplete(
          'container_runtime_cleanup_registration_unobservable',
          `Cannot verify exact XFS registration absence for ${quotaPath}`,
          { ...this.runtimeCleanupExpected(payload), quotaPath, cause: this.errorMessage(error) },
        );
      }
      if (observed.projectId !== null) {
        this.incomplete(
          'container_runtime_cleanup_registration_stale',
          `Exact XFS registration remains for ${quotaPath}`,
          { ...this.runtimeCleanupExpected(payload), registration: observed },
        );
      }
    }
  }

  private async assertNoRuntimeReferencesCleanupPaths(
    payload: RuntimeCleanupPayload,
    afterEffect: boolean,
  ): Promise<void> {
    let listed;
    try {
      listed = await this.docker.listAllContainers();
    } catch (error) {
      this.incomplete(
        'container_runtime_cleanup_inventory_unavailable',
        'Cannot collect a fresh all-container inventory before XFS cleanup',
        { ...this.runtimeCleanupExpected(payload), cause: this.errorMessage(error) },
      );
    }
    if (listed.length > 4096 || listed.some((container) => !container.Id)) {
      this.incomplete(
        'container_runtime_cleanup_inventory_invalid',
        'All-container inventory is empty-id or exceeds the cleanup safety bound',
        { ...this.runtimeCleanupExpected(payload), containerCount: listed.length },
      );
    }
    const firstIds = listed.map((container) => container.Id).sort();
    if (new Set(firstIds).size !== firstIds.length) {
      this.incomplete(
        'container_runtime_cleanup_inventory_invalid',
        'All-container inventory contains duplicate runtime ids',
        { ...this.runtimeCleanupExpected(payload), runtimeIds: firstIds },
      );
    }

    for (const candidate of listed) {
      let inspected;
      try {
        inspected = await this.inspectMaybe(candidate.Id);
      } catch (error) {
        this.incomplete(
          'container_runtime_cleanup_inventory_unavailable',
          `Cannot inspect runtime ${candidate.Id} while proving path exclusivity`,
          { ...this.runtimeCleanupExpected(payload), runtimeId: candidate.Id, cause: this.errorMessage(error) },
        );
      }
      if (!inspected) continue;
      if (inspected.Id !== candidate.Id) {
        this.incomplete(
          'container_runtime_cleanup_inventory_invalid',
          `Runtime ${candidate.Id} inspect returned a different physical identity`,
          {
            ...this.runtimeCleanupExpected(payload),
            listedRuntimeId: candidate.Id,
            inspectedRuntimeId: inspected.Id,
          },
        );
      }
      let graph;
      try {
        graph = await this.docker.getGraphDriverDirs(candidate.Id, inspected);
      } catch (error) {
        this.incomplete(
          'container_runtime_cleanup_inventory_unavailable',
          `Cannot inspect runtime ${candidate.Id} writable-layer paths`,
          { ...this.runtimeCleanupExpected(payload), runtimeId: candidate.Id, cause: this.errorMessage(error) },
        );
      }
      const paths = [graph.upperDir, graph.workDir];
      if (!this.validRuntimeCleanupPaths(paths)) {
        this.incomplete(
          'container_runtime_cleanup_inventory_unavailable',
          `Runtime ${candidate.Id} has unprovable writable-layer paths`,
          { ...this.runtimeCleanupExpected(payload), runtimeId: candidate.Id, observedPaths: paths },
        );
      }
      const referenced = paths.find((quotaPath) => payload.quotaPaths.includes(quotaPath));
      if (referenced) {
        this.failRuntimeCleanupClosed(
          payload,
          afterEffect,
          'container_runtime_cleanup_path_referenced',
          `Runtime ${candidate.Id} still references persisted cleanup path ${referenced}`,
          { referencingRuntimeId: candidate.Id, referencedPath: referenced },
        );
      }
    }

    let confirmed;
    try {
      confirmed = await this.docker.listAllContainers();
    } catch (error) {
      this.incomplete(
        'container_runtime_cleanup_inventory_unavailable',
        'Cannot confirm all-container inventory stability before XFS cleanup',
        { ...this.runtimeCleanupExpected(payload), cause: this.errorMessage(error) },
      );
    }
    const confirmedIds = confirmed.map((container) => container.Id).sort();
    if (
      confirmedIds.length !== firstIds.length
      || confirmedIds.some((runtimeId, index) => runtimeId !== firstIds[index])
    ) {
      this.incomplete(
        'container_runtime_cleanup_inventory_changed',
        'All-container inventory changed during XFS path-exclusivity proof',
        { ...this.runtimeCleanupExpected(payload), firstIds, confirmedIds },
      );
    }
  }

  private assertRuntimeCleanupIdentity(
    expected: RuntimeCleanupPayload,
    inspect: Awaited<ReturnType<DockerClient['inspectContainer']>>,
    afterEffect = false,
  ): void {
    const labels = inspect.Config?.Labels ?? {};
    if (
      inspect.Id === expected.runtimeId
      && labels[LABEL.MANAGED] === 'true'
      && labels[LABEL.CONTAINER_ID] === expected.containerId
      && labels[LABEL.SERVER_ID] === expected.serverId
      && labels[LABEL.SPEC_GENERATION] === expected.specGeneration
      && labels[LABEL.RUNTIME_SPEC_HASH] === expected.runtimeSpecHash
    ) return;
    this.failRuntimeCleanupClosed(
      expected,
      afterEffect,
      'container_runtime_cleanup_identity_mismatch',
      `Runtime ${expected.runtimeId} no longer has the exact reported immutable identity`,
      {
        ...this.runtimeCleanupObservation(inspect),
        present: true,
      },
    );
  }

  private validRuntimeCleanupPaths(quotaPaths: readonly string[]): quotaPaths is readonly [string, string] {
    const root = path.resolve(this.config.dockerRoot);
    return quotaPaths.length === 2
      && new Set(quotaPaths).size === 2
      && quotaPaths.every((quotaPath) => path.isAbsolute(quotaPath)
        && path.resolve(quotaPath) === quotaPath
        && quotaPath.startsWith(`${root}${path.sep}`));
  }

  private runtimeCleanupExpected(payload: RuntimeCleanupPayload): Record<string, unknown> {
    return {
      expectedRuntimeId: payload.runtimeId,
      expectedContainerId: payload.containerId,
      expectedServerId: payload.serverId,
      expectedSpecGeneration: payload.specGeneration,
      expectedRuntimeSpecHash: payload.runtimeSpecHash,
      expectedQuotaPaths: [...payload.quotaPaths],
    };
  }

  private failRuntimeCleanupClosed(
    payload: RuntimeCleanupPayload,
    afterEffect: boolean,
    code: string,
    message: string,
    observed: Record<string, unknown>,
  ): never {
    const evidence = { ...this.runtimeCleanupExpected(payload), ...observed };
    if (afterEffect) this.incomplete(code, message, evidence);
    this.managed(code, message, { ...evidence, applied: false });
  }

  private runtimeCleanupObservation(
    inspect: Awaited<ReturnType<DockerClient['inspectContainer']>>,
  ): Record<string, unknown> {
    const labels = inspect.Config?.Labels ?? {};
    return {
      runtimeId: inspect.Id,
      containerId: labels[LABEL.CONTAINER_ID] ?? null,
      serverId: labels[LABEL.SERVER_ID] ?? null,
      managed: labels[LABEL.MANAGED] ?? null,
      specGeneration: labels[LABEL.SPEC_GENERATION] ?? null,
      runtimeSpecHash: labels[LABEL.RUNTIME_SPEC_HASH] ?? null,
      running: inspect.State.Running,
      present: true,
    };
  }

  private async ensureSsh(runtimeId: string, ssh: ContainerSshTaskSpec): Promise<unknown> {
    try {
      return await this.dropbear.reconcileContainerSsh({ runtimeId, ...ssh });
    } catch (error) {
      const inspect = await this.docker.inspectContainer(runtimeId);
      const state = await this.dropbear.inspectContainerSshState(
        runtimeId,
        this.containerStatus(inspect.State.Status),
      );
      const mismatch = this.sshMismatch(ssh, state);
      if (!mismatch) return state;
      this.incomplete('container_ssh_incomplete', mismatch, {
        runtimeId,
        ssh: state,
        cause: this.errorMessage(error),
      });
    }
  }

  private async verifySsh(runtimeId: string, ssh: ContainerSshTaskSpec): Promise<void> {
    const inspect = await this.docker.inspectContainer(runtimeId);
    const state = await this.dropbear.inspectContainerSshState(
      runtimeId,
      this.containerStatus(inspect.State.Status),
    );
    const mismatch = this.sshMismatch(ssh, state);
    if (mismatch) this.managed('container_ssh_not_converged', mismatch, { runtimeId, ssh: state });
  }

  private sshMismatch(ssh: ContainerSshTaskSpec, state: Awaited<ReturnType<DropbearManager['inspectContainerSshState']>>): string | null {
    if (!ssh.enabled) {
      return state.enabled || state.status !== 'disabled' ? `SSH remains enabled for the container` : null;
    }
    if (state.status !== 'running') return 'SSH is not running for the container';
    if (ssh.internalKeyGeneration !== undefined && state.appliedKeyGeneration !== ssh.internalKeyGeneration) {
      return 'SSH key generation does not match the requested generation';
    }
    if (ssh.expectedKeyHash && state.keyHash !== ssh.expectedKeyHash) {
      return 'SSH key hash does not match the requested key';
    }
    return null;
  }

  private async requireRuntime(containerId: string, runtimeId?: string): Promise<string> {
    const resolved = await this.resolveRuntimeId(containerId, runtimeId);
    if (!resolved) {
      this.managed('container_absent', `Managed container ${containerId} does not exist`, {
        containerId,
        expectedRuntimeId: runtimeId ?? null,
        present: false,
      });
    }
    return resolved;
  }

  private async resolveRuntimeId(
    containerId: string,
    hintedRuntimeId?: string,
    createPayload?: ContainerCreateTaskPayload,
  ): Promise<string | null> {
    const containers = await this.docker.listNyabaseContainers();
    const matches = containers.filter((container) => container.Labels?.[LABEL.CONTAINER_ID] === containerId);
    if (matches.length > 1) {
      this.managed('container_identity_duplicate', `Multiple managed runtimes claim container ${containerId}`, {
        containerId,
        applied: false,
        runtimeIds: matches.map((container) => container.Id),
        runtimes: matches.map((container) => ({
          runtimeId: container.Id,
          serverId: container.Labels?.[LABEL.SERVER_ID] ?? null,
          runtimeSpecHash: container.Labels?.[LABEL.RUNTIME_SPEC_HASH] ?? null,
        })),
      });
    }
    const match = matches[0];
    if (match?.Id) {
      if (!this.identityLabelsValid(containerId, match.Labels ?? {})) {
        if (createPayload) {
          const inspect = await this.inspectMaybe(match.Id);
          if (inspect) {
            this.managed('container_identity_mismatch', `Runtime ${match.Id} has invalid managed identity labels`,
              {
                ...await this.createRuntimeObservation(createPayload, inspect),
                expectedContainerId: containerId,
                applied: false,
              });
          }
        }
        this.assertIdentityLabels(containerId, match.Id, match.Labels ?? {});
      }
      if (hintedRuntimeId && hintedRuntimeId !== match.Id) {
        this.managed('container_runtime_identity_conflict', `Runtime hint does not match the managed runtime for ${containerId}`, {
          containerId,
          applied: false,
          expectedRuntimeId: hintedRuntimeId,
          observedRuntimeId: match.Id,
        });
      }
      return match.Id;
    }
    if (!hintedRuntimeId) return null;
    const inspect = await this.inspectMaybe(hintedRuntimeId);
    if (!inspect) return null;
    this.assertIdentityLabels(containerId, hintedRuntimeId, inspect.Config?.Labels ?? {});
    return hintedRuntimeId;
  }

  private assertIdentityLabels(containerId: string, runtimeId: string, labels: Record<string, string>): void {
    const observed = {
      expectedContainerId: containerId,
      runtimeId,
      applied: false,
      managed: labels[LABEL.MANAGED] ?? null,
      containerId: labels[LABEL.CONTAINER_ID] ?? null,
      serverId: labels[LABEL.SERVER_ID] ?? null,
      runtimeSpecHash: labels[LABEL.RUNTIME_SPEC_HASH] ?? null,
    };
    if (!this.identityLabelsValid(containerId, labels)) {
      this.managed('container_identity_mismatch', `Runtime ${runtimeId} has invalid managed identity labels`, observed);
    }
  }

  private identityLabelsValid(containerId: string, labels: Record<string, string>): boolean {
    return labels[LABEL.MANAGED] === 'true'
      && labels[LABEL.CONTAINER_ID] === containerId
      && labels[LABEL.SERVER_ID] === this.config.serverId;
  }

  private async validateCreateRuntime(
    payload: ContainerCreateTaskPayload,
    runtimeId: string,
    mounts: ResolvedContainerMountSpec[],
  ): Promise<{ ip: string; runtimeSpecHash: string }> {
    const inspect = await this.inspectMaybe(runtimeId);
    if (!inspect) {
      this.managed('container_disappeared', `Runtime ${runtimeId} disappeared during create reconciliation`, {
        containerId: payload.containerId,
        runtimeId,
        present: false,
      });
    }
    if (!this.identityLabelsValid(payload.containerId, inspect.Config?.Labels ?? {})) {
      this.managed('container_identity_mismatch', `Runtime ${runtimeId} has invalid managed identity labels`,
        await this.createRuntimeObservation(payload, inspect));
    }
    if (inspect.Image !== payload.imageDockerId) {
      this.managed('container_image_identity_mismatch', `Runtime ${runtimeId} does not use the immutable requested image`, {
        ...await this.createRuntimeObservation(payload, inspect),
        expectedImageDockerId: payload.imageDockerId,
        actualImageDockerId: inspect.Image ?? null,
      });
    }
    const ip = this.containerIp(inspect);
    if (!ip) {
      this.managed('container_ip_missing', `Runtime ${runtimeId} has no observable macvlan IP`,
        await this.createRuntimeObservation(payload, inspect));
    }
    if (ip !== payload.assignedIp) {
      this.managed('container_ip_identity_mismatch', `Runtime ${runtimeId} does not use its Backend reservation`, {
        ...await this.createRuntimeObservation(payload, inspect),
        expectedIp: payload.assignedIp,
        actualIp: ip,
      });
    }
    const expectedHash = this.docker.runtimeSpecHash(
      this.runtimeSpec(payload, payload.assignedIp, mounts),
    );
    const actualGeneration = inspect.Config?.Labels?.[LABEL.SPEC_GENERATION] ?? null;
    const actualHash = inspect.Config?.Labels?.[LABEL.RUNTIME_SPEC_HASH] ?? null;
    if (actualGeneration !== String(payload.specGeneration) || actualHash !== expectedHash) {
      this.managed('container_runtime_spec_mismatch', `Runtime ${runtimeId} does not match the requested create generation/spec`, {
        ...await this.createRuntimeObservation(payload, inspect),
        expectedSpecGeneration: payload.specGeneration,
        actualSpecGeneration: actualGeneration,
        expectedRuntimeSpecHash: expectedHash,
        actualRuntimeSpecHash: actualHash,
      });
    }
    return { ip, runtimeSpecHash: expectedHash };
  }

  private runtimeSpec(
    payload: ContainerCreateTaskPayload,
    ip: string,
    mounts: ResolvedContainerMountSpec[],
  ): ContainerRuntimeSpec {
    return {
      specGeneration: payload.specGeneration,
      name: payload.name,
      imageRef: payload.imageDockerId,
      cpuMillis: payload.cpuMillis,
      memBytes: payload.memBytes,
      gpuIndices: payload.gpuIndices ?? [],
      ip,
      containerId: payload.containerId,
      ownerId: payload.ownerId,
      imageId: payload.imageId,
      runtimeOverrides: payload.runtimeOverrides,
      serverId: this.config.serverId,
      mounts,
    };
  }

  private async resolveMountSpecs(
    mounts: ContainerCreateTaskPayload['mounts'],
  ): Promise<ResolvedContainerMountSpec[]> {
    const resolved: ResolvedContainerMountSpec[] = [];
    for (const mount of mounts) {
      await this.assertMountSourceReady(mount);
      try {
        const hostPath = await this.dataDirs.resolveMountPath(
          mount.sourceId,
          mount.resourceId,
          mount.sourceIdentity,
        );
        // Path resolution can touch a remote inode and yield after the first
        // observation. Re-prove the exact mount source/options immediately
        // before the resolved bind source is accepted.
        await this.assertMountSourceReady(mount);
        resolved.push({ ...mount, hostPath });
      } catch (error) {
        try {
          await this.assertMountSourceReady(mount);
        } catch (sourceError) {
          if (sourceError instanceof IncompleteTaskError) throw sourceError;
          throw error;
        }
        const freshSource = this.dataDirs.inspectSource(mount.sourceId);
        let dataDir: unknown = null;
        try { dataDir = this.dataDirs.inspectDir(mount.sourceId, mount.resourceId); } catch { /* marker may be invalid */ }
        this.managed('container_mount_resource_invalid', `DataDir ${mount.resourceId} is missing, unsafe, or has the wrong identity`, {
          source: freshSource,
          dataDir,
          resourceId: mount.resourceId,
          cause: this.errorMessage(error),
        });
      }
    }
    return resolved;
  }

  private async assertMountSourcesReady(
    mounts: ContainerCreateTaskPayload['mounts'],
  ): Promise<void> {
    for (const mount of mounts) await this.assertMountSourceReady(mount);
  }

  private async assertMountSourceReady(
    mount: ContainerCreateTaskPayload['mounts'][number],
  ): Promise<void> {
    const observed = this.dataDirs.inspectSource(mount.sourceId);
    if (!observed.ready || observed.identity !== mount.sourceIdentity) {
      this.incomplete('container_mount_source_unavailable', `Mount source ${mount.sourceId} is unavailable or changed`, {
        ...observed,
        resourceId: mount.resourceId,
        expectedSourceIdentity: mount.sourceIdentity,
      });
    }
    if (observed.kind !== 'remote') return;

    const spec = this.remoteFsMounter.getSpec(mount.sourceId);
    let exactPhysicalMount = false;
    let observationError: string | null = null;
    if (spec && spec.hostMountPoint === observed.root) {
      try {
        exactPhysicalMount = await this.remoteFsMounter.verifyMounted(spec);
      } catch (error) {
        observationError = this.errorMessage(error);
      }
    }
    if (!spec || spec.hostMountPoint !== observed.root || !exactPhysicalMount) {
      this.incomplete(
        'container_remote_mount_unavailable',
        `Remote mount source ${mount.sourceId} does not match its bootstrapped physical specification`,
        {
          ...observed,
          resourceId: mount.resourceId,
          expectedSourceIdentity: mount.sourceIdentity,
          desiredHostMountPoint: spec?.hostMountPoint ?? null,
          observationError,
        },
      );
    }
  }

  private async inspectMaybe(
    runtimeId: string,
  ): Promise<Awaited<ReturnType<DockerClient['inspectContainer']>> | null> {
    try {
      return await this.docker.inspectContainer(runtimeId);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      throw error;
    }
  }

  private async verifyRunning(runtimeId: string): Promise<void> {
    const inspect = await this.docker.inspectContainer(runtimeId);
    if (!inspect.State.Running) {
      this.managed('container_not_running', `Container ${runtimeId} is not running`, this.runtimeObservation(inspect));
    }
  }

  private async startOrObserve(containerId: string, runtimeId: string): Promise<void> {
    try {
      await this.docker.startContainer(runtimeId);
    } catch (error) {
      const observed = await this.docker.inspectContainer(runtimeId);
      if (!observed.State.Running) {
        this.incomplete('container_start_incomplete', `Container ${containerId} has not started yet`, {
          ...this.runtimeObservation(observed),
          cause: this.errorMessage(error),
        });
      }
    }
  }

  private async assignQuotaPath(
    containerId: string,
    runtimeId: string,
    numericOwnerId: number,
    quotaPath: string,
  ): Promise<void> {
    try {
      await this.quota.addPathToProject(numericOwnerId, quotaPath);
    } catch (error) {
      let observed;
      try {
        observed = await this.quota.inspectPathAssignment(numericOwnerId, quotaPath);
      } catch {
        throw error;
      }
      if (!observed.assigned) {
        this.managed('container_quota_apply_failed', `Failed to assign quota path ${quotaPath}`, {
          containerId,
          runtimeId,
          quota: observed,
          cause: this.errorMessage(error),
        });
      }
    }
  }

  private assertDockerRoot(containerId: string, dockerRoot: string): void {
    if (dockerRoot === this.config.dockerRoot) return;
    this.managed('container_docker_root_mismatch', 'Task Docker root does not match Agent static configuration', {
      containerId,
      present: false,
      applied: false,
      expectedDockerRoot: this.config.dockerRoot,
      receivedDockerRoot: dockerRoot,
    });
  }

  private assertQuotaPaths(containerId: string, dockerRoot: string, quotaPaths: readonly string[]): void {
    this.assertDockerRoot(containerId, dockerRoot);
    const root = path.resolve(dockerRoot);
    const valid = quotaPaths.length === 2
      && new Set(quotaPaths).size === 2
      && quotaPaths.every((quotaPath) => path.isAbsolute(quotaPath)
        && path.resolve(quotaPath) === quotaPath
        && quotaPath.startsWith(`${root}${path.sep}`));
    if (valid) return;
    this.managed('container_quota_recovery_paths_invalid', 'Container writable-layer quota paths are invalid', {
      containerId,
      applied: false,
      dockerRoot,
      quotaPaths: [...quotaPaths],
    });
  }

  private async observeWritableLayerQuota(
    containerId: string,
    runtimeId: string,
    dockerRoot: string,
    numericOwnerId: number,
    quotaPaths: readonly string[],
  ): Promise<Awaited<ReturnType<XfsQuotaManager['inspectPathAssignment']>>[]> {
    this.assertQuotaPaths(containerId, dockerRoot, quotaPaths);
    const graph = await this.docker.getGraphDriverDirs(runtimeId);
    if (!graph.upperDir || !graph.workDir) {
      this.managed('container_quota_paths_unobservable', `Docker writable layer paths are unavailable for ${runtimeId}`, {
        ...this.runtimeObservation(await this.docker.inspectContainer(runtimeId)),
        graph,
      });
    }
    const observedPaths = [graph.upperDir, graph.workDir];
    const exact = new Set(observedPaths).size === 2
      && new Set([...observedPaths, ...quotaPaths]).size === 2;
    if (!exact) {
      this.managed('container_quota_recovery_metadata_mismatch', 'Durable quota paths do not match the runtime writable layer', {
        ...this.runtimeObservation(await this.docker.inspectContainer(runtimeId)),
        observedPaths,
        quotaPaths: [...quotaPaths],
      });
    }
    return Promise.all(quotaPaths.map((quotaPath) =>
      this.quota.inspectPathAssignment(numericOwnerId, quotaPath)));
  }

  private async ensureWritableLayerQuota(
    containerId: string,
    runtimeId: string,
    dockerRoot: string,
    numericOwnerId: number,
    quotaPaths: readonly string[],
  ): Promise<void> {
    let assignments = await this.observeWritableLayerQuota(
      containerId,
      runtimeId,
      dockerRoot,
      numericOwnerId,
      quotaPaths,
    );
    if (assignments.every((assignment) => assignment.assigned)) return;

    let runtime = await this.docker.inspectContainer(runtimeId);
    if (runtime.State.Running) {
      await this.docker.stopContainer(runtimeId);
      runtime = await this.docker.inspectContainer(runtimeId);
      if (runtime.State.Running) {
        this.incomplete('container_quota_repair_stop_unconfirmed', `Container ${containerId} must stop before quota assignment repair`, {
          ...this.runtimeObservation(runtime),
          assignments,
        });
      }
    }
    for (const quotaPath of quotaPaths) {
      await this.assignQuotaPath(containerId, runtimeId, numericOwnerId, quotaPath);
    }
    assignments = await this.observeWritableLayerQuota(
      containerId,
      runtimeId,
      dockerRoot,
      numericOwnerId,
      quotaPaths,
    );
    if (!assignments.every((assignment) => assignment.assigned)) {
      this.managed('container_quota_paths_not_converged', 'Container writable-layer quota assignments did not converge', {
        ...this.runtimeObservation(await this.docker.inspectContainer(runtimeId)),
        assignments,
      });
    }
  }

  private async verifyWritableLayerQuota(
    containerId: string,
    runtimeId: string,
    dockerRoot: string,
    numericOwnerId: number,
    quotaPaths: readonly string[],
  ): Promise<void> {
    const assignments = await this.observeWritableLayerQuota(
      containerId,
      runtimeId,
      dockerRoot,
      numericOwnerId,
      quotaPaths,
    );
    if (!assignments.every((assignment) => assignment.assigned)) {
      this.managed('container_quota_paths_not_converged', 'Container writable-layer quota assignments are not converged', {
        ...this.runtimeObservation(await this.docker.inspectContainer(runtimeId)),
        assignments,
      });
    }
  }

  private async verifyQuotaLimit(numericOwnerId: number, diskBytes: number): Promise<void> {
    const expected = normalizeXfsQuotaBytes(diskBytes);
    let usage;
    try {
      usage = await this.quota.getUsageForUser(numericOwnerId);
    } catch (error) {
      this.incomplete(
        'container_shared_quota_incomplete',
        `Container owner quota ${numericOwnerId} cannot be proven across every configured XFS source`,
        {
          numericOwnerId,
          expectedHardLimitBytes: expected,
          cause: this.errorMessage(error),
        },
      );
    }
    if (!usage) {
      this.managed(
        'container_shared_quota_missing',
        `Container owner quota ${numericOwnerId} is absent from the configured XFS filesystem`,
        { numericOwnerId, expectedHardLimitBytes: expected, present: false },
      );
    }
    if (usage.hardLimitBytes !== expected) {
      this.managed(
        'container_shared_quota_mismatch',
        `Container owner quota ${numericOwnerId} does not match the requested limit`,
        { ...usage, expectedHardLimitBytes: expected },
      );
    }
  }

  private async ensureQuotaLimit(numericOwnerId: number, diskBytes: number): Promise<void> {
    try {
      await this.quota.setLimit(numericOwnerId, diskBytes);
    } catch (error) {
      try {
        await this.verifyQuotaLimit(numericOwnerId, diskBytes);
      } catch (verifyError) {
        if (verifyError instanceof IncompleteTaskError) {
          const details = this.isRecord(verifyError.taskError.details)
            ? verifyError.taskError.details
            : {};
          throw new IncompleteTaskError({
            ...verifyError.taskError,
            details: { ...details, applyError: this.errorMessage(error) },
          });
        }
        throw verifyError;
      }
    }
  }

  private async ensureMounts(
    runtimeId: string,
    expected: Parameters<ContainerMountReconciler['ensure']>[1],
  ): Promise<ContainerMountObservation[]> {
    try {
      return (await this.mountReconciler.ensure(runtimeId, expected)).current;
    } catch (error) {
      if (error instanceof ContainerMountMismatchError) {
        this.managed('container_mounts_not_converged', error.message, { runtimeId, mounts: error.observed });
      }
      try {
        await this.mountReconciler.verify(runtimeId, expected);
        return await this.mountReconciler.observe(runtimeId);
      } catch (probeError) {
        if (probeError instanceof ContainerMountMismatchError) {
          this.managed('container_mounts_apply_failed', probeError.message, {
            runtimeId,
            mounts: probeError.observed,
            cause: this.errorMessage(error),
          });
        }
        throw error;
      }
    }
  }

  private async verifyMounts(
    runtimeId: string,
    expected: Parameters<ContainerMountReconciler['verify']>[1],
  ): Promise<void> {
    try {
      await this.mountReconciler.verify(runtimeId, expected);
    } catch (error) {
      if (error instanceof ContainerMountMismatchError) {
        this.managed('container_mounts_not_converged', error.message, { runtimeId, mounts: error.observed });
      }
      throw error;
    }
  }

  /**
   * A running workload is never left behind after quota, mount, or SSH
   * convergence fails. A terminal failure is emitted only after a fresh
   * Docker observation proves the runtime is stopped; an uncertain rollback
   * remains incomplete so Backend retains the task locks.
   */
  private async withStopOnConvergenceFailure<T>(
    containerId: string,
    runtimeId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      let observed: Awaited<ReturnType<DockerClient['inspectContainer']>>;
      try {
        observed = await this.docker.inspectContainer(runtimeId);
        if (observed.State.Running) {
          await this.docker.stopContainer(runtimeId);
          observed = await this.docker.inspectContainer(runtimeId);
        }
      } catch (rollbackError) {
        this.incomplete(
          'container_safety_stop_unconfirmed',
          `Could not confirm that container ${containerId} stopped after convergence failure`,
          {
            containerId,
            runtimeId,
            convergenceError: this.errorMessage(error),
            rollbackError: this.errorMessage(rollbackError),
          },
        );
      }

      if (observed.State.Running) {
        this.incomplete(
          'container_safety_stop_unconfirmed',
          `Container ${containerId} is still running after convergence failure`,
          {
            ...this.runtimeObservation(observed),
            convergenceError: this.errorMessage(error),
          },
        );
      }

      const rollback = this.runtimeObservation(observed);
      if (error instanceof IncompleteTaskError && this.isSharedQuotaIncomplete(error)) {
        const details = this.isRecord(error.taskError.details) ? error.taskError.details : {};
        throw new IncompleteTaskError({
          ...error.taskError,
          details: { ...details, safetyRollback: rollback },
        });
      }
      if (error instanceof ManagedTaskError) {
        throw new ManagedTaskError(error.taskError, { ...error.observed, safetyRollback: rollback });
      }
      if (error instanceof IncompleteTaskError) {
        throw new ManagedTaskError(error.taskError, { safetyRollback: rollback });
      }
      this.managed(
        'container_convergence_failed',
        `Container ${containerId} was stopped after convergence failed`,
        { safetyRollback: rollback, convergenceError: this.errorMessage(error) },
      );
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private isSharedQuotaIncomplete(error: IncompleteTaskError): boolean {
    return error.taskError.code === 'container_shared_quota_incomplete';
  }

  private runtimeObservation(
    inspect: Awaited<ReturnType<DockerClient['inspectContainer']>>,
  ): Record<string, unknown> {
    const runtimeSpecHash = inspect.Config?.Labels?.[LABEL.RUNTIME_SPEC_HASH] ?? null;
    return {
      runtimeId: inspect.Id,
      containerId: inspect.Config?.Labels?.[LABEL.CONTAINER_ID] ?? null,
      serverId: inspect.Config?.Labels?.[LABEL.SERVER_ID] ?? null,
      specGeneration: inspect.Config?.Labels?.[LABEL.SPEC_GENERATION] ?? null,
      runtimeSpecHash,
      specHash: runtimeSpecHash,
      running: inspect.State.Running,
      status: inspect.State.Status,
      startedAt: inspect.State.StartedAt,
      ip: this.containerIp(inspect),
    };
  }

  private async createRuntimeObservation(
    payload: ContainerCreateTaskPayload,
    inspect: Awaited<ReturnType<DockerClient['inspectContainer']>>,
  ): Promise<Record<string, unknown>> {
    const mounts = await this.mountReconciler.observe(inspect.Id);
    const ssh = await this.dropbear.inspectContainerSshState(
      inspect.Id,
      this.containerStatus(inspect.State.Status),
    );
    return { ...this.runtimeObservation(inspect), mounts, ssh };
  }

  private containerIp(inspect: Awaited<ReturnType<DockerClient['inspectContainer']>>): string {
    const networks = inspect.NetworkSettings?.Networks ?? {};
    const observed = networks[NYABASE_NETWORK] as {
      IPAddress?: string;
      IPAMConfig?: { IPv4Address?: string };
    } | undefined;
    return observed?.IPAddress || observed?.IPAMConfig?.IPv4Address || '';
  }

  private startedChanged(startedAt: string | undefined, baselineStartedAt: string): boolean {
    return Boolean(startedAt && startedAt !== baselineStartedAt);
  }

  private containerStatus(status: string): ContainerStatus {
    if (status === 'running') return ContainerStatus.Running;
    if (status === 'paused') return ContainerStatus.Paused;
    if (status === 'restarting') return ContainerStatus.Restarting;
    if (status === 'dead') return ContainerStatus.Dead;
    if (status === 'created' || status === 'exited') return ContainerStatus.Exited;
    return ContainerStatus.Unknown;
  }

  private managed(code: string, message: string, observed: Record<string, unknown>): never {
    throw new ManagedTaskError({ code, message }, observed);
  }

  private incomplete(code: string, message: string, details?: Record<string, unknown>): never {
    throw new IncompleteTaskError({ code, message, ...(details ? { details } : {}) });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
