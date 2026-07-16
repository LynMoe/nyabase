import { AgentTaskKind } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import type { DockerClient } from '../../docker/docker-client.js';
import { DockerTimeoutError } from '../../docker/docker-client.js';
import { ManagedTaskError } from '../task-handler.js';
import { ImageTaskHandler } from './image-task.handler.js';

describe('ImageTaskHandler', () => {
  it('reuses an already-present image on repeated execution without pulling again', async () => {
    const inspect = vi.fn().mockResolvedValue({ Id: 'sha256:present' });
    const pullImage = vi.fn();
    const handler = new ImageTaskHandler({
      pullImage,
      inspectImage: inspect,
    } as unknown as DockerClient);
    const payload = { dockerRef: 'example:latest', imageId: 'image-a' };

    const first = await handler.ensure(AgentTaskKind.ImageEnsurePresent, payload);
    await handler.verify(AgentTaskKind.ImageEnsurePresent, payload, first);
    const second = await handler.ensure(AgentTaskKind.ImageEnsurePresent, payload);
    await handler.verify(AgentTaskKind.ImageEnsurePresent, payload, second);

    expect(first).toEqual(second);
    expect(pullImage).not.toHaveBeenCalled();
  });

  it('accepts an image that appears after an ambiguous pull timeout', async () => {
    const inspect = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { statusCode: 404 }))
      .mockResolvedValueOnce({ Id: 'sha256:late' });
    const pullImage = vi.fn().mockRejectedValue(new DockerTimeoutError('pull(example)', 60_000));
    const handler = new ImageTaskHandler({
      pullImage,
      inspectImage: inspect,
    } as unknown as DockerClient);

    await expect(handler.ensure(AgentTaskKind.ImageEnsurePresent, {
      dockerRef: 'example:latest',
      imageId: 'image-a',
    })).resolves.toEqual({
      imageId: 'image-a',
      dockerId: 'sha256:late',
      dockerRef: 'example:latest',
    });
    expect(pullImage).toHaveBeenCalledOnce();
  });

  it('reports a fully observed missing image as a managed failure', async () => {
    const inspect = vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { statusCode: 404 }));
    const handler = new ImageTaskHandler({
      inspectImage: inspect,
    } as unknown as DockerClient);

    await expect(handler.verify(AgentTaskKind.ImageEnsurePresent, {
      dockerRef: 'example:latest',
    }, {
      imageId: null,
      dockerId: 'sha256:expected',
      dockerRef: 'example:latest',
    })).rejects.toMatchObject({
      name: ManagedTaskError.name,
      observed: { dockerRef: 'example:latest', present: false },
    });
  });

  it.each([401, 404, 500])(
    'terminalizes a settled pull HTTP %s when a fresh inspect proves the image absent',
    async (statusCode) => {
      const inspectImage = vi.fn()
        .mockRejectedValue(Object.assign(new Error('missing'), { statusCode: 404 }));
      const pullImage = vi.fn().mockRejectedValue(
        Object.assign(new Error(`registry rejected pull with ${statusCode}`), { statusCode }),
      );
      const handler = new ImageTaskHandler({ pullImage, inspectImage } as unknown as DockerClient);

      await expect(handler.ensure(AgentTaskKind.ImageEnsurePresent, {
        dockerRef: 'example:missing',
        imageId: 'image-a',
      })).rejects.toMatchObject({
        name: ManagedTaskError.name,
        taskError: {
          code: 'image_pull_failed',
          details: { statusCode },
        },
        observed: {
          dockerRef: 'example:missing',
          present: false,
          applied: false,
        },
      });
    },
  );
});
