import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PgAuditSnapshotResolver } from './audit-snapshot.resolver.js';

describe('PgAuditSnapshotResolver', () => {
  it('reads canonical infrastructure snapshots from the caller executor', async () => {
    const { executor, selectedTables } = fakeExecutor({
      'infra.servers': {
      name: 'Compute A',
      slug: 'compute-a',
      status: 'online',
      },
    });
    const resolver = new PgAuditSnapshotResolver();

    await expect(resolver.resolve(
      executor,
      'server',
      'server-a',
    )).resolves.toEqual({
      id: 'server-a',
      type: 'server',
      name: 'Compute A',
      labels: {
        slug: 'compute-a',
        status: 'online',
      },
    });
    expect(selectedTables).toEqual(['infra.servers']);
  });

  it('keeps null snapshot behavior when a canonical resource disappeared', async () => {
    const { executor } = fakeExecutor({ 'infra.images': undefined });
    const resolver = new PgAuditSnapshotResolver();

    await expect(resolver.resolve(
      executor,
      'image',
      'image-a',
      { name: 'Deleted image' },
    )).resolves.toBeNull();
  });

  it('preserves container, storage, and mount-grant snapshot shapes', async () => {
    const grantId = randomUUID();
    const { executor } = fakeExecutor({
      'control.containers': {
        name: 'Notebook',
        server_id: 'server-a',
        owner_id: 'user-a',
        image_id: 'image-a',
        created_by: 'admin-a',
      },
      'control.data_directories': {
        name: 'work',
        user_id: 'user-a',
        source_kind: 'remote',
        source_id: 'mount-a',
        server_id: null,
        desired_state: 'active',
      },
      'iam.mount_source_grants': {
        id: grantId,
        user_id: 'user-a',
        group_id: null,
        source_kind: 'remote',
        source_id: 'mount-a',
      },
      'iam.users': {
        username: 'alice',
        display_name: 'Alice',
        status: 'active',
        numeric_id: 1001,
      },
      'infra.remote_fs_mounts': {
        name: 'shared',
        display_name: 'Shared Data',
        type: 'nfs',
        host_mount_point: '/mnt/remote-fs/mount-a',
        desired_state: 'active',
      },
    });
    const resolver = new PgAuditSnapshotResolver();

    await expect(resolver.resolve(executor, 'container', 'container-a'))
      .resolves.toMatchObject({
        type: 'container',
        name: 'Notebook',
        labels: { ownerId: 'user-a', serverId: 'server-a' },
      });
    await expect(resolver.resolve(executor, 'datadir', 'directory-a'))
      .resolves.toMatchObject({
        type: 'datadir',
        name: 'work',
        labels: { sourceKind: 'remote', sourceId: 'mount-a' },
      });
    await expect(resolver.resolve(executor, 'mount_source', grantId))
      .resolves.toEqual({
        id: grantId,
        type: 'mount_source_grant',
        name: 'Alice (alice) -> Shared Data',
        labels: {
          scope: 'user',
          scopeId: 'user-a',
          sourceKind: 'remote',
          sourceId: 'mount-a',
        },
      });
  });

  it('does not query the UUID grant key for a natural local source id', async () => {
    const { executor, selectedTables } = fakeExecutor({});
    const resolver = new PgAuditSnapshotResolver();

    await expect(resolver.resolve(
      executor,
      'mount_source',
      'node-a-local',
      { sourceKind: 'local', sourceId: 'node-a-local' },
    )).resolves.toMatchObject({
      id: 'node-a-local',
      type: 'mount_source',
    });
    expect(selectedTables).not.toContain('iam.mount_source_grants');
  });
});

function fakeExecutor(rows: Record<string, Record<string, unknown> | undefined>) {
  const selectedTables: string[] = [];
  const executor = {
    selectFrom(table: string) {
      selectedTables.push(table);
      const builder = {
        select: () => builder,
        where: () => builder,
        executeTakeFirst: async () => rows[table],
      };
      return builder;
    },
  };
  return { executor: executor as never, selectedTables };
}
