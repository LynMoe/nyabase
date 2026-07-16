import {
  AgentTaskKind,
  zRemoteFsAbsentTaskPayload,
  zRemoteFsEnsureTaskPayload,
  remoteFsSourceIdentity,
} from '@nyabase/common';
import type { DataDirsManager } from '../../datadirs/data-dirs.js';
import { PhysicalReferenceGuardError } from '../../docker/physical-reference-guard.js';
import { FsCleanupIncompleteError } from '../../fs/fs-driver.js';
import type { RemoteFsMounter } from '../../fs/remote-fs-mounter.js';
import { IncompleteTaskError, ManagedTaskError, type AgentTaskHandler } from '../task-handler.js';

export class RemoteFsTaskHandler implements AgentTaskHandler {
  readonly kinds = [AgentTaskKind.RemoteFsEnsure, AgentTaskKind.RemoteFsAbsent] as const;

  constructor(
    private readonly mounter: RemoteFsMounter,
    private readonly dataDirs: DataDirsManager,
  ) {}

  async ensure(kind: AgentTaskKind, payload: unknown): Promise<unknown> {
    if (kind === AgentTaskKind.RemoteFsEnsure) {
      const parsed = zRemoteFsEnsureTaskPayload.parse(payload);
      let applied;
      try {
        applied = await this.mounter.applyMount(parsed);
      } catch (error) {
        this.throwIfCleanupIncomplete(error, {
          operation: 'ensure',
          id: parsed.id,
          hostMountPoint: parsed.hostMountPoint,
        });
        if (error instanceof PhysicalReferenceGuardError) {
          this.physicalReferenceFailure(error, {
            operation: 'ensure',
            id: parsed.id,
            desiredHostMountPoint: parsed.hostMountPoint,
          });
        }
        let mounted: boolean;
        try {
          mounted = await this.mounter.verifyMounted(parsed);
        } catch {
          throw error;
        }
        if (!mounted) {
          this.managed(
            'remote_fs_mount_failed',
            `Remote filesystem ${parsed.id} did not mount`,
            {
              id: parsed.id,
              hostMountPoint: parsed.hostMountPoint,
              mounted: false,
              cause: this.errorMessage(error),
            },
          );
        }
        applied = this.mounter.getSpec(parsed.id) ?? parsed;
      }
      this.dataDirs.addSource({
        kind: 'remote',
        id: parsed.id,
        root: applied.hostMountPoint,
        identity: remoteFsSourceIdentity(applied.params),
        quotaEnabled: false,
      });
      return { id: parsed.id, hostMountPoint: applied.hostMountPoint };
    }
    const parsed = zRemoteFsAbsentTaskPayload.parse(payload);
    const fallback = { hostMountPoint: parsed.hostMountPoint, options: parsed.options, params: parsed.params };
    try {
      await this.mounter.removeMount(parsed.id, fallback);
    } catch (error) {
      this.throwIfCleanupIncomplete(error, {
        operation: 'absent',
        id: parsed.id,
        hostMountPoint: parsed.hostMountPoint,
      });
      if (error instanceof PhysicalReferenceGuardError) {
        this.physicalReferenceFailure(error, {
          operation: 'absent',
          id: parsed.id,
          hostMountPoint: parsed.hostMountPoint,
        });
      }
      let unmounted: boolean;
      try {
        unmounted = await this.mounter.verifyUnmounted(parsed.id, fallback);
      } catch {
        throw error;
      }
      if (!unmounted) {
        this.managed(
          'remote_fs_remove_failed',
          `Remote filesystem ${parsed.id} remains mounted`,
          {
            id: parsed.id,
            hostMountPoint: parsed.hostMountPoint,
            mounted: true,
            cause: this.errorMessage(error),
          },
        );
      }
    }
    this.dataDirs.removeSource(parsed.id);
    return { id: parsed.id };
  }

  async verify(kind: AgentTaskKind, payload: unknown): Promise<void> {
    if (kind === AgentTaskKind.RemoteFsEnsure) {
      const parsed = zRemoteFsEnsureTaskPayload.parse(payload);
      if (!await this.mounter.verifyMounted(parsed)) {
        throw new ManagedTaskError({
          code: 'remote_fs_not_mounted',
          message: `Remote filesystem ${parsed.id} is not mounted`,
        }, { id: parsed.id, mounted: false, hostMountPoint: parsed.hostMountPoint });
      }
      return;
    }
    const parsed = zRemoteFsAbsentTaskPayload.parse(payload);
    const fallback = { hostMountPoint: parsed.hostMountPoint, options: parsed.options, params: parsed.params };
    if (!await this.mounter.verifyUnmounted(parsed.id, fallback)) {
      throw new ManagedTaskError({
        code: 'remote_fs_still_mounted',
        message: `Remote filesystem ${parsed.id} is still mounted`,
      }, { id: parsed.id, mounted: true, hostMountPoint: parsed.hostMountPoint });
    }
  }

  private managed(code: string, message: string, observed: Record<string, unknown>): never {
    throw new ManagedTaskError({ code, message }, observed);
  }

  private physicalReferenceFailure(
    error: PhysicalReferenceGuardError,
    resource: Record<string, unknown>,
  ): never {
    if (error.code === 'physical_path_referenced') {
      throw new ManagedTaskError({
        code: error.code,
        message: error.message,
      }, {
        ...resource,
        ...error.details,
        applied: false,
        residualPresent: true,
        reason: 'running_bind_reference',
      });
    }
    throw new IncompleteTaskError({
      code: error.code,
      message: error.message,
      details: error.details,
    });
  }

  private throwIfCleanupIncomplete(
    error: unknown,
    resource: Record<string, unknown>,
  ): void {
    if (!(error instanceof FsCleanupIncompleteError)) return;
    throw new IncompleteTaskError({
      code: 'remote_fs_cleanup_incomplete',
      message: error.message,
      details: {
        ...resource,
        cause: this.errorMessage(error.cleanupCause),
      },
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
