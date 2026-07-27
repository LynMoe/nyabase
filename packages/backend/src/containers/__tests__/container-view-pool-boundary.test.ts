import { describe, expect, it } from 'vitest';
import { ContainerControlService } from '../container-control.service.js';

describe('ContainerControlService view pool boundary', () => {
  it('serializes projection reads and batches container task lookups', async () => {
    const service = Object.create(
      ContainerControlService.prototype,
    ) as ContainerControlService;
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const read = async <T>(label: string, value: T): Promise<T> => {
      calls.push(label);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return value;
    };
    const internal = service as unknown as {
      serverMap: () => Promise<Map<string, never>>;
      imageMap: () => Promise<Map<string, never>>;
      userMap: () => Promise<Map<string, never>>;
      repository: {
        routes: () => Promise<Map<string, never>>;
        listMounts: () => Promise<never[]>;
      };
      containerTasks: {
        findPendingMany: () => Promise<Map<string, never>>;
      };
      omittedServerLoginContainerIds: () => Promise<Set<string>>;
      toView: (container: { id: string }) => Promise<{ id: string }>;
      viewsFor: (
        containers: Array<{
          id: string;
          serverId: string;
          imageId: string;
          ownerId: string;
        }>,
      ) => Promise<Array<{ id: string }>>;
    };
    internal.serverMap = () => read('servers', new Map<string, never>());
    internal.imageMap = () => read('images', new Map<string, never>());
    internal.userMap = () => read('users', new Map<string, never>());
    internal.repository = {
      routes: () => read('routes', new Map<string, never>()),
      listMounts: () => read('mounts', []),
    };
    internal.containerTasks = {
      findPendingMany: () => read('active-tasks', new Map<string, never>()),
    };
    internal.omittedServerLoginContainerIds = () =>
      read('omitted-logins', new Set());
    internal.toView = (container) => read(`view:${container.id}`, {
      id: container.id,
    });

    await expect(internal.viewsFor([
      { id: 'container-a', serverId: 'server-a', imageId: 'image-a', ownerId: 'user-a' },
      { id: 'container-b', serverId: 'server-b', imageId: 'image-b', ownerId: 'user-b' },
    ])).resolves.toEqual([
      { id: 'container-a' },
      { id: 'container-b' },
    ]);

    expect(maxActive).toBe(1);
    expect(calls).toEqual([
      'servers',
      'images',
      'users',
      'routes',
      'mounts',
      'active-tasks',
      'omitted-logins',
      'view:container-a',
      'view:container-b',
    ]);
  });
});
