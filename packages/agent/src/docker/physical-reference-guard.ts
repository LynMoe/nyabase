import * as path from 'path';
import { LABEL } from '@nyabase/common';
import type { DockerClient } from './docker-client.js';

export interface PhysicalReferenceGuard {
  /**
   * Prove from a fresh Docker inventory that no running managed runtime holds
   * a bind reference overlapping the host path that is about to be removed or
   * unmounted. A failed proof must reject; callers must not perform the effect.
   */
  assertNoRunningBindReferences(targetPath: string): Promise<void>;
}

export type PhysicalReferenceGuardErrorCode =
  | 'physical_path_referenced'
  | 'physical_reference_observation_failed';

/** A safety fence failure. Durable task callers must classify this as incomplete. */
export class PhysicalReferenceGuardError extends Error {
  constructor(
    readonly code: PhysicalReferenceGuardErrorCode,
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PhysicalReferenceGuardError';
  }
}

type ContainerInspect = Awaited<ReturnType<DockerClient['inspectContainer']>>;

/**
 * Last-mile physical reference fence.
 *
 * Backend references are deliberately irrelevant here: the guard re-lists the
 * locally managed Docker inventory and freshly inspects every runtime. This
 * catches control-plane drift and runtimes unknown to the current Backend
 * projection. Docker observation ambiguity is unsafe, so it rejects closed.
 */
export class DockerPhysicalReferenceGuard implements PhysicalReferenceGuard {
  constructor(private readonly docker: DockerClient) {}

  async assertNoRunningBindReferences(rawTargetPath: string): Promise<void> {
    const targetPath = this.strictAbsolutePath(rawTargetPath, 'targetPath');
    let listed: Awaited<ReturnType<DockerClient['listNyabaseContainers']>>;
    try {
      listed = await this.docker.listNyabaseContainers();
    } catch (error) {
      this.observationFailed('Could not list managed Docker runtimes', {
        targetPath,
        phase: 'list',
        cause: this.errorMessage(error),
      });
    }
    if (!Array.isArray(listed)) {
      this.observationFailed('Managed Docker inventory is not an observable list', {
        targetPath,
        phase: 'list_shape',
      });
    }

    const ids: string[] = [];
    const seen = new Set<string>();
    for (const runtime of listed!) {
      const runtimeId = runtime.Id;
      if (
        typeof runtimeId !== 'string'
        || runtimeId.length === 0
        || runtime.Labels?.[LABEL.MANAGED] !== 'true'
        || seen.has(runtimeId)
      ) {
        this.observationFailed('Managed Docker inventory has ambiguous runtime identity', {
          targetPath,
          phase: 'list_identity',
          runtimeId: typeof runtimeId === 'string' ? runtimeId : null,
        });
      }
      seen.add(runtimeId);
      ids.push(runtimeId);
    }

    // Await every fresh inspection even when one fails. The safety decision is
    // made only after the complete finite observation batch has settled.
    const observations = await Promise.all(ids.map(async (runtimeId) => {
      try {
        return { runtimeId, inspect: await this.docker.inspectContainer(runtimeId), error: null };
      } catch (error) {
        return { runtimeId, inspect: null, error };
      }
    }));

    const failed = observations.find((observation) => observation.error !== null);
    if (failed) {
      this.observationFailed(`Could not inspect managed runtime ${failed.runtimeId}`, {
        targetPath,
        phase: 'inspect',
        runtimeId: failed.runtimeId,
        cause: this.errorMessage(failed.error),
      });
    }

    for (const observation of observations) {
      const inspect = observation.inspect;
      if (!inspect || typeof inspect !== 'object') {
        this.observationFailed(`Managed runtime ${observation.runtimeId} returned no inspect object`, {
          targetPath,
          phase: 'inspect_shape',
          runtimeId: observation.runtimeId,
        });
      }
      this.assertInspectIdentity(targetPath, observation.runtimeId, inspect);
      if (typeof inspect.State?.Running !== 'boolean') {
        this.observationFailed(`Runtime ${observation.runtimeId} has no definite running state`, {
          targetPath,
          phase: 'inspect_state',
          runtimeId: observation.runtimeId,
        });
      }
      if (!inspect.State.Running) continue;
      if (!Array.isArray(inspect.Mounts)) {
        this.observationFailed(`Running runtime ${observation.runtimeId} has no observable mount set`, {
          targetPath,
          phase: 'inspect_mounts',
          runtimeId: observation.runtimeId,
        });
      }

      for (const [mountIndex, mount] of inspect.Mounts.entries()) {
        if (!mount || typeof mount.Type !== 'string') {
          this.observationFailed(`Runtime ${observation.runtimeId} has an ambiguous mount entry`, {
            targetPath,
            phase: 'inspect_mount',
            runtimeId: observation.runtimeId,
            mountIndex,
          });
        }
        if (mount.Type !== 'bind') continue;
        let sourcePath: string;
        try {
          sourcePath = this.strictAbsolutePath(mount.Source, 'bind Mount.Source');
        } catch (error) {
          this.observationFailed(`Runtime ${observation.runtimeId} has an unsafe bind source`, {
            targetPath,
            phase: 'inspect_bind_source',
            runtimeId: observation.runtimeId,
            mountIndex,
            source: typeof mount.Source === 'string' ? mount.Source : null,
            cause: this.errorMessage(error),
          });
        }

        const relationship = this.overlapRelationship(sourcePath!, targetPath);
        if (relationship) {
          throw new PhysicalReferenceGuardError(
            'physical_path_referenced',
            `Running managed runtime ${observation.runtimeId} has a bind mount overlapping ${targetPath}`,
            {
              targetPath,
              runtimeId: observation.runtimeId,
              mountIndex,
              sourcePath,
              relationship,
            },
          );
        }
      }
    }
  }

  private assertInspectIdentity(
    targetPath: string,
    runtimeId: string,
    inspect: ContainerInspect,
  ): void {
    if (
      inspect.Id !== runtimeId
      || inspect.Config?.Labels?.[LABEL.MANAGED] !== 'true'
    ) {
      this.observationFailed(`Managed runtime ${runtimeId} changed identity during inspection`, {
        targetPath,
        phase: 'inspect_identity',
        runtimeId,
        observedRuntimeId: typeof inspect.Id === 'string' ? inspect.Id : null,
        observedManagedLabel: inspect.Config?.Labels?.[LABEL.MANAGED] ?? null,
      });
    }
  }

  private strictAbsolutePath(raw: unknown, field: string): string {
    if (
      typeof raw !== 'string'
      || raw.length === 0
      || raw.includes('\0')
      || raw.includes('\\')
      || !path.posix.isAbsolute(raw)
    ) {
      throw new Error(`${field} must be an absolute canonical POSIX path`);
    }
    const normalized = path.posix.resolve(raw);
    if (normalized !== raw) {
      throw new Error(`${field} is not canonical: ${raw} -> ${normalized}`);
    }
    return normalized;
  }

  private overlapRelationship(
    sourcePath: string,
    targetPath: string,
  ): 'exact' | 'source_inside_target' | 'source_contains_target' | null {
    if (sourcePath === targetPath) return 'exact';
    if (this.strictlyInside(sourcePath, targetPath)) return 'source_inside_target';
    // A parent bind can retain a child mount in the container mount namespace,
    // so it is unsafe for the same physical operation even though the common
    // resource shape normally binds only descendants.
    if (this.strictlyInside(targetPath, sourcePath)) return 'source_contains_target';
    return null;
  }

  private strictlyInside(candidate: string, root: string): boolean {
    const relative = path.posix.relative(root, candidate);
    return relative !== ''
      && relative !== '..'
      && !relative.startsWith('../')
      && !path.posix.isAbsolute(relative);
  }

  private observationFailed(message: string, details: Record<string, unknown>): never {
    throw new PhysicalReferenceGuardError(
      'physical_reference_observation_failed',
      message,
      details,
    );
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
