import { randomUUID } from 'node:crypto';
import {
  Capability,
  MAX_GROUP_MEMBERS,
  MAX_PLATFORM_GROUPS,
  RemoteFsType,
  SystemGroupKey,
} from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { groupsPgFixture } from './groups.pg-test-helper.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('GroupsService PostgreSQL security boundaries', () => {
  it('prevents ManageGroups from assigning capabilities the actor lacks', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await groupsPgFixture(fixture, {
        actorCapabilities: [Capability.ManageGroups],
      });
      await expect(context.service.create({
        name: 'Escalation',
        capabilities: [Capability.ManageUsers],
      }, context.actorId)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
      });
      expect(await fixture.database.selectFrom('iam.groups')
        .select('id')
        .where('name', '=', 'Escalation')
        .executeTakeFirst()).toBeUndefined();
    });
  });

  it('serializes concurrent group admission at the global catalog cap', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await groupsPgFixture(fixture);
      await fixture.database.insertInto('iam.groups').values(
        Array.from({ length: MAX_PLATFORM_GROUPS - 3 }, (_, index) => ({
          id: randomUUID(),
          name: `Capacity ${index}`,
          description: null,
          priority: 0,
          is_system: false,
          system_key: null,
          capabilities: [],
          revision: 1,
        })),
      ).execute();

      const attempts = await Promise.allSettled([
        context.service.create({ name: 'Capacity winner A' }, context.actorId),
        context.service.create({ name: 'Capacity winner B' }, context.actorId),
      ]);
      expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      const rejected = attempts.find(({ status }) => status === 'rejected');
      expect(rejected).toMatchObject({
        reason: {
          response: expect.objectContaining({ code: 'GROUP_CAPACITY_REACHED' }),
        },
      });
      expect(await context.service.findAll()).toHaveLength(MAX_PLATFORM_GROUPS);
    });
  });

  it('serializes the final group-member slot and keeps list payloads bounded', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await groupsPgFixture(fixture);
      const existing = Array.from(
        { length: MAX_GROUP_MEMBERS - 1 },
        (_, index) => ({
          id: randomUUID(),
          numeric_id: 2_000 + index,
          username: `capacity-member-${index}`,
          password_hash: 'unused',
          display_name: `Capacity member ${index}`,
          status: 'active',
          auth_version: 1,
          authz_version: 1,
        }),
      );
      const candidates = [0, 1].map((index) => ({
        id: randomUUID(),
        numeric_id: 3_000 + index,
        username: `capacity-candidate-${index}`,
        password_hash: 'unused',
        display_name: `Capacity candidate ${index}`,
        status: 'active',
        auth_version: 1,
        authz_version: 1,
      }));
      await fixture.database.insertInto('iam.users')
        .values([...existing, ...candidates])
        .execute();
      await fixture.database.insertInto('iam.group_members').values(existing.map((user) => ({
        id: randomUUID(),
        group_id: context.groupId,
        user_id: user.id,
      }))).execute();

      const attempts = await Promise.allSettled(candidates.map((user) =>
        context.service.addMember(context.groupId, user.id, context.actorId)));
      expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(attempts.find(({ status }) => status === 'rejected')).toMatchObject({
        reason: {
          response: expect.objectContaining({
            code: 'GROUP_MEMBER_CAPACITY_REACHED',
            maxMembers: MAX_GROUP_MEMBERS,
          }),
        },
      });
      const members = await context.service.listMembers(context.groupId);
      expect(members).toHaveLength(MAX_GROUP_MEMBERS);
      const listed = (await context.service.findAll())
        .find(({ id }) => id === context.groupId);
      expect(listed?.memberCount).toBe(MAX_GROUP_MEMBERS);
      expect(listed?.members).toHaveLength(MAX_GROUP_MEMBERS);
    });
  });

  it('rejects oversized group-delete quota fanout before mutating the group', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await groupsPgFixture(fixture);
      const members = Array.from({ length: MAX_GROUP_MEMBERS }, (_, index) => ({
        id: randomUUID(),
        numeric_id: 4_000 + index,
        username: `fanout-member-${index}`,
        password_hash: 'unused',
        display_name: `Fanout member ${index}`,
        status: 'active',
        auth_version: 1,
        authz_version: 1,
      }));
      const secondServerId = randomUUID();
      await fixture.database.insertInto('iam.users').values(members).execute();
      await fixture.database.insertInto('iam.group_members').values(members.map((user) => ({
        id: randomUUID(),
        group_id: context.groupId,
        user_id: user.id,
      }))).execute();
      await fixture.database.insertInto('infra.servers').values({
        id: secondServerId,
        name: 'Fanout second server',
        slug: `fanout-${secondServerId.slice(0, 8)}`,
        agent_token_hash: 'b'.repeat(64),
        host_fingerprint: null,
        agent_config_fingerprint: null,
        status: 'offline',
        quarantine_code: null,
        quarantine_message: null,
        last_seen_at: null,
        macvlan_cidr: null,
        macvlan_gateway: null,
        macvlan_reserved_ips: '[]',
        revision: 1,
      }).execute();
      await fixture.database.insertInto('iam.server_grants').values(
        [context.serverId, secondServerId].map((serverId) => ({
          id: randomUUID(),
          user_id: null,
          group_id: context.groupId,
          server_id: serverId,
          cpu_millis: null,
          mem_bytes: null,
          disk_bytes: 1024,
          gpu_mode: null,
          gpu_indices: null,
        })),
      ).execute();

      await expect(context.service.delete(context.groupId, context.actorId))
        .rejects.toMatchObject({
          response: expect.objectContaining({
            code: 'QUOTA_FANOUT_LIMIT',
            operation: 'delete-group',
            requestedIntents: MAX_GROUP_MEMBERS * 2,
          }),
        });
      expect(await fixture.database.selectFrom('iam.groups')
        .select('id').where('id', '=', context.groupId).executeTakeFirst())
        .toBeTruthy();
      expect(await fixture.database.selectFrom('iam.group_members')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('group_id', '=', context.groupId).executeTakeFirstOrThrow())
        .toMatchObject({ count: String(MAX_GROUP_MEMBERS) });
    });
  });

  it('guards local and remote mount dependencies when removing a member and honors an exact alternative', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await groupsPgFixture(fixture, { member: true });
      const sources = await seedGroupMountDependencies(
        fixture.database,
        context.groupId,
        context.userId,
        context.serverId,
      );

      await expect(context.service.removeMember(
        context.groupId,
        context.userId,
        context.actorId,
      )).rejects.toMatchObject({
        response: expect.objectContaining({ sourceKind: 'local' }),
      });
      await fixture.database.deleteFrom('control.authorization_dependencies')
        .where('dependency_id', '=', sources.localDependencyId)
        .execute();
      await expect(context.service.removeMember(
        context.groupId,
        context.userId,
        context.actorId,
      )).rejects.toMatchObject({
        response: expect.objectContaining({ sourceKind: 'remote' }),
      });
      await fixture.database.insertInto('iam.mount_source_grants').values({
        id: randomUUID(),
        user_id: context.userId,
        group_id: null,
        source_kind: 'remote',
        source_id: sources.remoteSourceId,
        server_id: null,
        source_identity: null,
      }).execute();
      await expect(context.service.removeMember(
        context.groupId,
        context.userId,
        context.actorId,
      )).resolves.toEqual({ taskIds: [] });
    });
  });

  it('guards local and remote mount dependencies when deleting a group and honors an exact alternative', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await groupsPgFixture(fixture, { member: true });
      const sources = await seedGroupMountDependencies(
        fixture.database,
        context.groupId,
        context.userId,
        context.serverId,
      );

      await expect(context.service.delete(context.groupId, context.actorId))
        .rejects.toMatchObject({
          response: expect.objectContaining({ sourceKind: 'local' }),
        });
      await fixture.database.deleteFrom('control.authorization_dependencies')
        .where('dependency_id', '=', sources.localDependencyId)
        .execute();
      await expect(context.service.delete(context.groupId, context.actorId))
        .rejects.toMatchObject({
          response: expect.objectContaining({ sourceKind: 'remote' }),
        });
      await fixture.database.insertInto('iam.mount_source_grants').values({
        id: randomUUID(),
        user_id: context.userId,
        group_id: null,
        source_kind: 'remote',
        source_id: sources.remoteSourceId,
        server_id: null,
        source_identity: null,
      }).execute();
      await expect(context.service.delete(context.groupId, context.actorId))
        .resolves.toEqual({ taskIds: [] });
    });
  });

  it('rechecks ManageGrants for direct mutations even on an absent row', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await groupsPgFixture(fixture, {
        actorCapabilities: [Capability.ManageGroups],
      });
      await expect(context.service.deleteUserServerGrant(
        context.userId,
        context.serverId,
        context.actorId,
      )).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
      });
    });
  });

  it('separates JWT credential invalidation from authorization-only generation changes', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await groupsPgFixture(fixture, {
        actorCapabilities: Object.values(Capability),
        member: true,
      });
      const before = await fixture.database.selectFrom('iam.users')
        .select(['auth_version', 'authz_version'])
        .where('id', '=', context.userId)
        .executeTakeFirstOrThrow();
      await context.service.update(
        context.groupId,
        { capabilities: [Capability.ViewAudit] },
        context.actorId,
        1,
      );
      const updated = await fixture.database.selectFrom('iam.users')
        .select(['auth_version', 'authz_version'])
        .where('id', '=', context.userId)
        .executeTakeFirstOrThrow();
      expect(Number(updated.auth_version)).toBe(Number(before.auth_version) + 1);
      expect(Number(updated.authz_version)).toBe(Number(before.authz_version) + 1);

      await context.service.update(
        context.groupId,
        { priority: 42 },
        context.actorId,
        2,
      );
      const reprioritized = await fixture.database.selectFrom('iam.users')
        .select(['auth_version', 'authz_version'])
        .where('id', '=', context.userId)
        .executeTakeFirstOrThrow();
      expect(Number(reprioritized.auth_version)).toBe(Number(updated.auth_version));
      expect(Number(reprioritized.authz_version)).toBe(Number(updated.authz_version) + 1);

      await context.service.removeMember(
        context.groupId,
        context.userId,
        context.actorId,
      );
      const removed = await fixture.database.selectFrom('iam.users')
        .select(['auth_version', 'authz_version'])
        .where('id', '=', context.userId)
        .executeTakeFirstOrThrow();
      expect(Number(removed.auth_version)).toBe(Number(reprioritized.auth_version) + 1);
      expect(Number(removed.authz_version)).toBe(Number(reprioritized.authz_version) + 1);
    });
  });

  it('keeps idempotent delete misses out of audit and invalidation', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await groupsPgFixture(fixture);
      const committed = vi.spyOn(context.access, 'authorizationCommitted');
      await expect(context.service.deleteUserImageGrant(
        context.userId,
        'image-a',
        context.serverId,
        context.actorId,
      )).resolves.toBeUndefined();
      expect(context.audit.log).not.toHaveBeenCalled();
      expect(committed).not.toHaveBeenCalled();
    });
  });

  it('keeps built-in identity immutable and rejects reserved-name squatting', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await groupsPgFixture(fixture, {
        actorCapabilities: Object.values(Capability),
      });
      const administrators = randomUUID();
      await fixture.database.insertInto('iam.groups').values({
        id: administrators,
        name: 'Administrators',
        description: null,
        priority: 1000,
        is_system: true,
        system_key: SystemGroupKey.Administrators,
        capabilities: Object.values(Capability),
        revision: 1,
      }).execute();
      await expect(context.service.update(
        administrators,
        { name: 'Renamed' },
        context.actorId,
        1,
      )).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'SYSTEM_GROUP_METADATA_IMMUTABLE' }),
      });
      await expect(context.service.create(
        { name: 'Users' },
        context.actorId,
      )).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'SYSTEM_GROUP_NAME_RESERVED' }),
      });
    });
  });

  it('returns no grant projections from the ManageGroups list and fences stale revisions', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await groupsPgFixture(fixture, {
        actorCapabilities: Object.values(Capability),
        member: true,
      });
      const first = await context.service.findById(context.groupId);
      const listed = (await context.service.findAll())
        .find((group) => group.id === context.groupId)!;
      expect(listed.members).toHaveLength(1);
      expect(listed).not.toHaveProperty('serverGrants');
      const saved = await context.service.update(
        context.groupId,
        { description: 'Committed' },
        context.actorId,
        first.revision,
      );
      expect(saved).toMatchObject({ revision: 2, description: 'Committed' });
      await expect(context.service.update(
        context.groupId,
        { description: 'Stale' },
        context.actorId,
        first.revision,
      )).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'GROUP_REVISION_CONFLICT',
          current: expect.objectContaining({ revision: 2 }),
        }),
      });
    });
  });
});

async function seedGroupMountDependencies(
  database: Parameters<typeof groupsPgFixture>[0]['database'],
  groupId: string,
  userId: string,
  serverId: string,
) {
  const remoteSourceId = randomUUID();
  const localDependencyId = randomUUID();
  await database.insertInto('infra.remote_fs_mounts').values({
    id: remoteSourceId,
    name: `guard-${remoteSourceId.slice(0, 8)}`,
    display_name: null,
    description: null,
    type: RemoteFsType.Nfs,
    host_mount_point: `/mnt/remote-fs/${remoteSourceId}`,
    options: '',
    params: {
      type: RemoteFsType.Nfs,
      nfsServer: 'nfs.internal',
      exportPath: '/guard',
      version: '4.2',
    },
    desired_state: 'active',
    generation: 1,
    last_task_id: null,
  }).execute();
  await database.insertInto('iam.mount_source_grants').values([
    {
      id: randomUUID(),
      user_id: null,
      group_id: groupId,
      source_kind: 'local',
      source_id: 'disk-guard',
      server_id: serverId,
      source_identity: 'disk-guard-identity',
    },
    {
      id: randomUUID(),
      user_id: null,
      group_id: groupId,
      source_kind: 'remote',
      source_id: remoteSourceId,
      server_id: null,
      source_identity: null,
    },
  ]).execute();
  await database.insertInto('control.authorization_dependencies').values([
    {
      id: randomUUID(),
      dependency_kind: 'data_directory',
      dependency_id: localDependencyId,
      user_id: userId,
      server_id: serverId,
      source_kind: 'local',
      source_id: 'disk-guard',
      source_identity: 'disk-guard-identity',
    },
    {
      id: randomUUID(),
      dependency_kind: 'data_directory',
      dependency_id: randomUUID(),
      user_id: userId,
      server_id: serverId,
      source_kind: 'remote',
      source_id: remoteSourceId,
      source_identity: null,
    },
  ]).execute();
  return { localDependencyId, remoteSourceId };
}
