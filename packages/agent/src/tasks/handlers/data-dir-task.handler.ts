import {
  AgentTaskKind,
  normalizeXfsQuotaBytes,
  zDataDirAbsentTaskPayload,
  zDataDirEnsureTaskPayload,
} from '@nyabase/common';
import {
  DataDirIdentityConflictError,
  DataDirOperationIncompleteError,
  type DataDirObservation,
  type DataDirsManager,
} from '../../datadirs/data-dirs.js';
import {
  PhysicalReferenceGuardError,
  type PhysicalReferenceGuard,
} from '../../docker/physical-reference-guard.js';
import type { RemoteFsMounter } from '../../fs/remote-fs-mounter.js';
import type { XfsQuotaManager } from '../../quota/xfs-quota.js';
import type { QuotaUsage } from '../../quota/xfs-quota.js';
import type { AgentWsClient } from '../../ws/client.js';
import { IncompleteTaskError, ManagedTaskError, type AgentTaskHandler } from '../task-handler.js';

type DataDirTaskResult = DataDirObservation & { quotaAssigned: boolean };

export class DataDirTaskHandler implements AgentTaskHandler<DataDirTaskResult> {
  readonly kinds = [AgentTaskKind.DataDirEnsure, AgentTaskKind.DataDirAbsent] as const;

  constructor(
    private readonly dataDirs: DataDirsManager,
    private readonly quota: XfsQuotaManager,
    private readonly remoteFsMounter: RemoteFsMounter,
    private readonly ws: AgentWsClient,
    private readonly physicalReferenceGuard: PhysicalReferenceGuard,
  ) {}

  async ensure(kind: AgentTaskKind, payload: unknown): Promise<DataDirTaskResult> {
    if (kind === AgentTaskKind.DataDirEnsure) {
      const parsed = zDataDirEnsureTaskPayload.parse(payload);
      await this.assertSourceReady(parsed.diskId, parsed.sourceIdentity);
      const source = this.dataDirs.getSource(parsed.diskId);
      const quotaAssigned = source?.kind === 'local' && source.quotaEnabled;
      const before = this.dataDirs.inspectDir(parsed.diskId, parsed.resourceId);
      if (quotaAssigned !== parsed.quotaRequired) {
        this.managed(
          'data_dir_quota_policy_mismatch',
          `DataDir ${parsed.resourceId} source quota policy does not match Backend intent`,
          {
            ...before,
            expectedResourceId: parsed.resourceId,
            quotaAssigned,
            quotaRequired: parsed.quotaRequired,
            applied: false,
          },
        );
      }
      if (before.exists && !before.isDirectory) {
        this.managed('data_dir_path_conflict', `Data directory path is not a directory: ${before.path}`, {
          ...before,
          expectedResourceId: parsed.resourceId,
          applied: false,
        });
      }
      // A DataDir must never become visible under a stale/unlimited project.
      // This task owns the shared quota lock and self-heals the durable quota
      // intent before creating the inode, even if the earlier QuotaEnsure
      // task failed.
      if (quotaAssigned) {
        try {
          await this.ensureQuotaLimit(parsed.numericUserId, parsed.diskBytes);
        } catch (error) {
          if (error instanceof ManagedTaskError) {
            throw new ManagedTaskError(error.taskError, {
              ...before,
              expectedResourceId: parsed.resourceId,
              applied: false,
              quotaObservation: error.observed,
            });
          }
          throw error;
        }
      }

      try {
        await this.dataDirs.createDir(
          parsed.diskId,
          parsed.uid,
          parsed.resourceId,
          parsed.sourceIdentity,
        );
      } catch (error) {
        const inspected = this.tryInspectDir(parsed.diskId, parsed.resourceId);
        if (error instanceof DataDirOperationIncompleteError) {
          this.incomplete(
            'data_dir_apply_incomplete',
            `DataDir ${parsed.resourceId} may be only partially applied`,
            {
              ...inspected.details,
              expectedUid: parsed.uid,
              expectedResourceId: parsed.resourceId,
              operation: error.operation,
              cause: error.message,
            },
          );
        }
        if (!inspected.observation) {
          this.incomplete(
            'data_dir_apply_unconfirmed',
            `Could not confirm the physical state of DataDir ${parsed.resourceId} after apply failed`,
            {
              ...inspected.details,
              expectedUid: parsed.uid,
              expectedResourceId: parsed.resourceId,
              cause: this.errorMessage(error),
            },
          );
        }
        this.managed('data_dir_apply_failed', `Failed to apply DataDir ${parsed.resourceId}`, {
          ...inspected.details,
          expectedUid: parsed.uid,
          expectedResourceId: parsed.resourceId,
          cause: this.errorMessage(error),
        });
      }
      const afterCreate = this.dataDirs.inspectDir(parsed.diskId, parsed.resourceId);
      if (quotaAssigned) {
        try {
          await this.dataDirs.withPinnedDir(
            parsed.diskId,
            parsed.resourceId,
            parsed.sourceIdentity,
            (pinnedPath, durablePath) => this.quota.addPathToProject(
              parsed.numericUserId,
              pinnedPath,
              durablePath,
            ),
          );
        } catch (error) {
          let quotaObservation;
          try {
            quotaObservation = await this.dataDirs.withPinnedDir(
              parsed.diskId,
              parsed.resourceId,
              parsed.sourceIdentity,
              (pinnedPath, durablePath) => this.quota.inspectPathAssignment(
                parsed.numericUserId,
                pinnedPath,
                durablePath,
              ),
            );
          } catch {
            throw error;
          }
          if (!quotaObservation.assigned) {
            this.managed('data_dir_quota_apply_failed', `Failed to assign quota for ${afterCreate.path}`, {
              ...afterCreate,
              expectedResourceId: parsed.resourceId,
              quotaObservation,
              cause: this.errorMessage(error),
            });
          }
        }
      }
      this.ws.emit('dataDirChanged');
      return { ...afterCreate, quotaAssigned };
    }

    const parsed = zDataDirAbsentTaskPayload.parse(payload);
    await this.assertSourceReady(parsed.diskId, parsed.sourceIdentity);
    const source = this.dataDirs.getSource(parsed.diskId);
    const quotaAssigned = source?.kind === 'local' && source.quotaEnabled;
    const before = this.dataDirs.inspectDir(parsed.diskId, parsed.resourceId);
    await this.assertPathUnreferenced(before.path, {
      operation: 'absent',
      diskId: parsed.diskId,
      expectedResourceId: parsed.resourceId,
      ...before,
    });
    try {
      await this.dataDirs.deleteDir(
        parsed.diskId,
        parsed.resourceId,
        parsed.sourceIdentity,
      );
    } catch (error) {
      const inspected = this.tryInspectDir(parsed.diskId, parsed.resourceId);
      const observed = inspected.observation;
      if (error instanceof DataDirIdentityConflictError) {
        if (!observed) {
          this.incomplete(
            'data_dir_identity_unconfirmed',
            `Could not safely observe the conflicting DataDir ${parsed.resourceId}`,
            {
              ...inspected.details,
              expectedResourceId: parsed.resourceId,
              cause: this.errorMessage(error),
            },
          );
        }
        this.managed('data_dir_identity_conflict', error.message, {
          ...inspected.details,
          expectedResourceId: parsed.resourceId,
        });
      }
      if (!observed || observed.exists || observed.resourceId !== null) {
        this.incomplete('data_dir_remove_incomplete', `DataDir ${parsed.resourceId} is not absent yet`, {
          ...inspected.details,
          cause: this.errorMessage(error),
        });
      }
    }

    // The inode must be gone before the durable /etc/projects registration is
    // scrubbed. If the process dies between these effects, replay observes the
    // absence and rolls forward through only this cleanup.
    if (quotaAssigned) {
      try {
        this.quota.removePathFromProject(parsed.numericUserId, before.path);
      } catch (error) {
        if (this.quota.isPathRegisteredToProject(parsed.numericUserId, before.path)) {
          this.incomplete('data_dir_quota_cleanup_incomplete', `Quota registration for ${before.path} is not absent yet`, {
            ...this.dataDirs.inspectDir(parsed.diskId, parsed.resourceId),
            quotaRegistrationPresent: true,
            cause: this.errorMessage(error),
          });
        }
      }
    }
    this.ws.emit('dataDirChanged');
    return { ...this.dataDirs.inspectDir(parsed.diskId, parsed.resourceId), quotaAssigned };
  }

  async verify(kind: AgentTaskKind, payload: unknown, result: DataDirTaskResult): Promise<void> {
    if (kind === AgentTaskKind.DataDirEnsure) {
      const parsed = zDataDirEnsureTaskPayload.parse(payload);
      await this.assertSourceReady(parsed.diskId, parsed.sourceIdentity);
      const observed = this.dataDirs.inspectDir(parsed.diskId, parsed.resourceId);
      const source = this.dataDirs.getSource(parsed.diskId);
      const sourceQuotaEnabled = source?.kind === 'local' && source.quotaEnabled;
      if (sourceQuotaEnabled !== parsed.quotaRequired) {
        this.incomplete(
          'data_dir_quota_policy_changed',
          `DataDir ${parsed.resourceId} source quota policy changed before verification`,
          { quotaRequired: parsed.quotaRequired, quotaAssigned: sourceQuotaEnabled },
        );
      }
      const expectsQuota = parsed.quotaRequired;
      if (expectsQuota) {
        try {
          await this.verifyQuotaLimit(parsed.numericUserId, parsed.diskBytes);
        } catch (error) {
          if (!(error instanceof ManagedTaskError)) throw error;
          let observedDir: DataDirObservation;
          try {
            // The quota observation was captured after ensure. Pair it with a
            // fresh physical directory observation so terminal evidence never
            // describes an earlier pre-verify state or violates Backend's
            // DataDir safety schema.
            observedDir = this.dataDirs.inspectDir(parsed.diskId, parsed.resourceId);
          } catch (inspectionError) {
            this.incomplete(
              'data_dir_final_observation_unavailable',
              `Could not observe DataDir ${parsed.resourceId} after final quota verification failed`,
              {
                expectedResourceId: parsed.resourceId,
                quotaObservation: error.observed,
                cause: this.errorMessage(inspectionError),
              },
            );
          }
          throw new ManagedTaskError(error.taskError, {
            ...observedDir,
            expectedResourceId: parsed.resourceId,
            quotaObservation: error.observed,
          });
        }
      }
      let ownershipMismatch: string | null;
      try {
        ownershipMismatch = observed.exists
          ? await this.dataDirs.verifyOwnership(
            parsed.diskId,
            parsed.uid,
            parsed.resourceId,
            parsed.sourceIdentity,
          )
          : observed.path;
      } catch (error) {
        if (error instanceof DataDirOperationIncompleteError) {
          this.incomplete(
            'data_dir_ownership_unobservable',
            `Could not fully observe DataDir ${parsed.resourceId} ownership`,
            {
              ...observed,
              expectedUid: parsed.uid,
              operation: error.operation,
              cause: error.message,
            },
          );
        }
        throw error;
      }
      const quotaObservation = expectsQuota && observed.exists
        ? await this.dataDirs.withPinnedDir(
          parsed.diskId,
          parsed.resourceId,
          parsed.sourceIdentity,
          (pinnedPath, durablePath) => this.quota.inspectPathAssignment(
            parsed.numericUserId,
            pinnedPath,
            durablePath,
          ),
        )
        : null;
      const quotaAssigned = !expectsQuota || quotaObservation?.assigned === true;
      if (
        !observed.exists
        || !observed.isDirectory
        || observed.resourceId !== parsed.resourceId
        || ownershipMismatch !== null
        || !quotaAssigned
      ) {
        this.managed('data_dir_not_converged', `DataDir ${parsed.resourceId} did not converge`, {
          ...observed,
          expectedUid: parsed.uid,
          expectedResourceId: parsed.resourceId,
          ownershipMismatch,
          quotaAssigned,
          quotaObservation,
        });
      }
      return;
    }

    const parsed = zDataDirAbsentTaskPayload.parse(payload);
    await this.assertSourceReady(parsed.diskId, parsed.sourceIdentity);
    const observed = this.dataDirs.inspectDir(parsed.diskId, parsed.resourceId);
    const registrationPresent = result.quotaAssigned
      && this.quota.isPathRegisteredToProject(parsed.numericUserId, observed.path);
    if (observed.exists || observed.resourceId !== null || registrationPresent) {
      this.incomplete('data_dir_not_absent', `DataDir ${parsed.resourceId} was not fully removed`, {
        ...observed,
        quotaRegistrationPresent: registrationPresent,
      });
    }
  }

  private managed(code: string, message: string, observed: Record<string, unknown>): never {
    throw new ManagedTaskError({ code, message }, observed);
  }

  private async ensureQuotaLimit(numericUserId: number, diskBytes: number): Promise<void> {
    try {
      await this.quota.setLimit(numericUserId, diskBytes);
    } catch (error) {
      try {
        await this.verifyQuotaLimit(numericUserId, diskBytes);
      } catch (verifyError) {
        if (verifyError instanceof IncompleteTaskError) {
          const details = verifyError.taskError.details;
          throw new IncompleteTaskError({
            ...verifyError.taskError,
            details: {
              ...(details && typeof details === 'object' && !Array.isArray(details) ? details : {}),
              applyError: this.errorMessage(error),
            },
          });
        }
        throw verifyError;
      }
    }
  }

  private async verifyQuotaLimit(numericUserId: number, diskBytes: number): Promise<void> {
    const expected = normalizeXfsQuotaBytes(diskBytes);
    let usage: QuotaUsage | null;
    try {
      usage = await this.quota.getUsageForUser(numericUserId);
    } catch (error) {
      this.incomplete(
        'data_dir_quota_unobservable',
        `DataDir owner quota ${numericUserId} cannot be observed`,
        { numericUserId, expectedHardLimitBytes: expected, cause: this.errorMessage(error) },
      );
    }
    if (!usage || usage.hardLimitBytes !== expected) {
      this.managed(
        usage ? 'data_dir_quota_mismatch' : 'data_dir_quota_missing',
        `DataDir owner quota ${numericUserId} does not match the durable desired limit`,
        {
          numericUserId,
          expectedHardLimitBytes: expected,
          observed: usage ? { ...usage } : null,
        },
      );
    }
  }

  private tryInspectDir(
    sourceId: string,
    resourceId: string,
  ): { observation: DataDirObservation | null; details: Record<string, unknown> } {
    try {
      const observation = this.dataDirs.inspectDir(sourceId, resourceId);
      return { observation, details: { ...observation } };
    } catch (error) {
      return {
        observation: null,
        details: { sourceId, resourceId, inspectionError: this.errorMessage(error) },
      };
    }
  }

  private async assertSourceReady(sourceId: string, expectedIdentity: string): Promise<void> {
    const observed = this.dataDirs.inspectSource(sourceId);
    if (!observed.ready || observed.identity !== expectedIdentity) {
      this.incomplete(
        'data_dir_source_unavailable',
        `Data source ${sourceId} is not mounted at its configured root`,
        { ...observed, expectedIdentity },
      );
    }
    if (observed.kind !== 'remote') return;

    const spec = this.remoteFsMounter.getSpec(sourceId);
    if (
      !spec
      || spec.hostMountPoint !== observed.root
      || !await this.remoteFsMounter.verifyMounted(spec)
    ) {
      this.incomplete(
        'data_dir_remote_source_unready',
        `Remote data source ${sourceId} does not match its active mount specification`,
        { ...observed, desiredHostMountPoint: spec?.hostMountPoint ?? null },
      );
    }
  }

  private incomplete(code: string, message: string, details?: Record<string, unknown>): never {
    throw new IncompleteTaskError({ code, message, ...(details ? { details } : {}) });
  }

  private async assertPathUnreferenced(
    targetPath: string,
    resource: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.physicalReferenceGuard.assertNoRunningBindReferences(targetPath);
    } catch (error) {
      if (error instanceof PhysicalReferenceGuardError) {
        if (error.code === 'physical_path_referenced') {
          this.managed(error.code, error.message, {
            ...resource,
            ...error.details,
            applied: false,
            residualPresent: true,
            reason: 'running_bind_reference',
          });
        }
        this.incomplete(error.code, error.message, error.details);
      }
      throw error;
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
