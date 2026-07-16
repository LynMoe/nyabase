import {
  AgentTaskKind,
  zImageEnsureAbsentTaskPayload,
  zImageEnsurePresentTaskPayload,
} from '@nyabase/common';
import type { DockerClient } from '../../docker/docker-client.js';
import { ManagedTaskError, type AgentTaskHandler } from '../task-handler.js';

type ImageTaskResult = { imageId: string | null; dockerId: string; dockerRef: string };
type ImageAbsentTaskResult = { imageId: string; dockerId: string | null; dockerRef: string; present: false };

export class ImageTaskHandler implements AgentTaskHandler<ImageTaskResult | ImageAbsentTaskResult> {
  readonly kinds = [AgentTaskKind.ImageEnsurePresent, AgentTaskKind.ImageEnsureAbsent] as const;

  constructor(private readonly docker: DockerClient) {}

  async ensure(kind: AgentTaskKind, payload: unknown): Promise<ImageTaskResult | ImageAbsentTaskResult> {
    if (kind === AgentTaskKind.ImageEnsureAbsent) {
      return this.ensureAbsent(zImageEnsureAbsentTaskPayload.parse(payload));
    }
    const parsed = zImageEnsurePresentTaskPayload.parse(payload);
    let inspect = await this.inspectMaybe(parsed.dockerRef);
    if (!inspect) {
      try {
        await this.docker.pullImage(parsed.dockerRef);
      } catch (error) {
        // DockerClient fail-stops on transport ambiguity, so any error that is
        // returned here is a completed daemon/registry response. A fresh 404
        // is therefore a terminal, proved no-effect failure.
        inspect = await this.inspectMaybe(parsed.dockerRef);
        if (!inspect) {
          throw new ManagedTaskError({
            code: 'image_pull_failed',
            message: `Image ${parsed.dockerRef} could not be pulled`,
            details: {
              statusCode: (error as { statusCode?: unknown }).statusCode ?? null,
              cause: error instanceof Error ? error.message : String(error),
            },
          }, {
            dockerRef: parsed.dockerRef,
            present: false,
            applied: false,
          });
        }
      }
      inspect ??= await this.docker.inspectImage(parsed.dockerRef);
    }
    return { imageId: parsed.imageId ?? null, dockerId: inspect.Id, dockerRef: parsed.dockerRef };
  }

  async verify(
    kind: AgentTaskKind,
    payload: unknown,
    result: ImageTaskResult | ImageAbsentTaskResult,
  ): Promise<void> {
    if (kind === AgentTaskKind.ImageEnsureAbsent) {
      const parsed = zImageEnsureAbsentTaskPayload.parse(payload);
      const inspect = await this.inspectMaybe(parsed.dockerRef);
      if (inspect) {
        throw new ManagedTaskError({
          code: 'image_still_present',
          message: `Image ${parsed.dockerRef} is still present after removal`,
        }, {
          dockerRef: parsed.dockerRef,
          dockerId: inspect.Id,
          present: true,
        });
      }
      return;
    }
    const parsed = zImageEnsurePresentTaskPayload.parse(payload);
    const inspect = await this.inspectMaybe(parsed.dockerRef);
    if (!inspect) {
      throw new ManagedTaskError({
        code: 'image_not_present',
        message: `Image ${parsed.dockerRef} is missing after pull`,
      }, { dockerRef: parsed.dockerRef, present: false });
    }
    if (inspect.Id !== result.dockerId) {
      throw new ManagedTaskError({
        code: 'image_identity_changed',
        message: `Image ${parsed.dockerRef} changed during verification`,
        details: { expectedDockerId: result.dockerId },
      }, { dockerRef: parsed.dockerRef, present: true, dockerId: inspect.Id });
    }
  }

  private async ensureAbsent(
    parsed: ReturnType<typeof zImageEnsureAbsentTaskPayload.parse>,
  ): Promise<ImageAbsentTaskResult> {
    const before = await this.inspectMaybe(parsed.dockerRef);
    if (!before) {
      return { imageId: parsed.imageId, dockerId: null, dockerRef: parsed.dockerRef, present: false };
    }
    try {
      await this.docker.removeImage(parsed.dockerRef);
    } catch (error) {
      const current = await this.inspectMaybe(parsed.dockerRef);
      if (current) {
        throw new ManagedTaskError({
          code: 'image_remove_failed',
          message: `Image ${parsed.dockerRef} could not be removed`,
          details: {
            dockerId: current.Id,
            statusCode: (error as { statusCode?: unknown }).statusCode ?? null,
            cause: error instanceof Error ? error.message : String(error),
          },
        }, {
          dockerRef: parsed.dockerRef,
          dockerId: current.Id,
          present: true,
        });
      }
    }
    const after = await this.inspectMaybe(parsed.dockerRef);
    if (after) {
      throw new ManagedTaskError({
        code: 'image_still_present',
        message: `Image ${parsed.dockerRef} is still present after removal`,
      }, { dockerRef: parsed.dockerRef, dockerId: after.Id, present: true });
    }
    return {
      imageId: parsed.imageId,
      dockerId: before.Id,
      dockerRef: parsed.dockerRef,
      present: false,
    };
  }

  private async inspectMaybe(reference: string): Promise<Awaited<ReturnType<DockerClient['inspectImage']>> | null> {
    try {
      return await this.docker.inspectImage(reference);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      throw error;
    }
  }
}
