import { randomUUID } from 'node:crypto';
import {
  AgentTaskKind,
  Capability,
  GpuGrantMode,
  UserStatus,
} from '@nyabase/common';
import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AgentTaskPayloadCodecService } from '../agent-tasks/agent-task-payload-codec.service.js';
import { WorkflowDispatchService } from '../agent-tasks/workflow-dispatch.service.js';
import { WorkflowFinalizerWorkerService } from '../agent-tasks/workflow-finalizer-worker.service.js';
import { WorkflowFinalizerRegistry } from '../agent-tasks/workflow-finalizer.registry.js';
import { createReadyAgentSession } from '../agent-tasks/workflow.pg-test-helper.js';
import { WorkflowRepository } from '../agent-tasks/workflow.repository.js';
import {
  withPostgresTestDatabase,
  type PostgresTestDatabase,
} from '../persistence-pg/postgres-test-harness.js';
import { QuotaWorkflowFinalizerService } from '../quota/quota-workflow-finalizer.service.js';
import { groupsPgFixture } from './groups.pg-test-helper.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('Groups PostgreSQL access revocation', () => {
  it('rolls back a group mutation when required audit append fails', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await groupsPgFixture(fixture);
      vi.mocked(context.audit.log).mockRejectedValueOnce(new Error('audit unavailable'));
      await expect(context.service.create(
        { name: 'Atomic Audit Group' },
        context.actorId,
      )).rejects.toThrow('audit unavailable');
      expect(await fixture.database.selectFrom('iam.groups')
        .select('id')
        .where('name', '=', 'Atomic Audit Group')
        .executeTakeFirst()).toBeUndefined();
    });
  });

  it('rolls back the final Server grant while an owned resource remains', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await groupsPgFixture(fixture);
      await fixture.database.insertInto('iam.server_grants').values(
        directGrant(context.userId, context.serverId, 4096),
      ).execute();
      await dependency(fixture, context.userId, context.serverId, 'container');
      await expect(context.service.deleteUserServerGrant(
        context.userId,
        context.serverId,
        context.actorId,
      )).rejects.toBeInstanceOf(ConflictException);
      expect(await fixture.database.selectFrom('iam.server_grants')
        .select('id')
        .where('user_id', '=', context.userId)
        .where('server_id', '=', context.serverId)
        .executeTakeFirst()).toBeTruthy();
    });
  });

  it('deletes a direct override when inherited access remains and syncs alternate quota', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await groupsPgFixture(fixture, {
        member: true,
        groupGrantBytes: 4096,
      });
      await context.service.upsertUserServerGrant(
        context.userId,
        context.serverId,
        { diskBytes: 8192 },
        context.actorId,
      );
      const result = await context.service.deleteUserServerGrant(
        context.userId,
        context.serverId,
        context.actorId,
      );
      expect(result.taskIds).toEqual([expect.any(String)]);
      expect(await context.storage.findQuotaDesired(
        context.serverId,
        context.userId,
      )).toMatchObject({ limitBytes: 4096, lastTaskId: result.taskIds[0] });
    });
  });

  it('allows a resource-free final revoke without inventing unlimited quota', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await groupsPgFixture(fixture);
      const applied = await context.service.upsertUserServerGrant(
        context.userId,
        context.serverId,
        { diskBytes: 8192 },
        context.actorId,
      );
      const removed = await context.service.deleteUserServerGrant(
        context.userId,
        context.serverId,
        context.actorId,
      );
      expect(removed.taskIds).toEqual([]);
      expect(await context.storage.findQuotaDesired(
        context.serverId,
        context.userId,
      )).toMatchObject({ limitBytes: 8192, lastTaskId: applied.taskIds[0] });
    });
  });

  it('rolls back inherited membership and group deletion while dependencies remain', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await groupsPgFixture(fixture, {
        member: true,
        groupGrantBytes: 4096,
      });
      await dependency(fixture, context.userId, context.serverId, 'data_directory');
      await expect(context.service.removeMember(
        context.groupId,
        context.userId,
        context.actorId,
      )).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ACCESS_REVOKE_HAS_RESOURCES' }),
      });
      await expect(context.service.delete(
        context.groupId,
        context.actorId,
      )).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ACCESS_REVOKE_HAS_RESOURCES' }),
      });
      expect(await fixture.database.selectFrom('iam.group_members')
        .select('id')
        .where('group_id', '=', context.groupId)
        .where('user_id', '=', context.userId)
        .executeTakeFirst()).toBeTruthy();
    });
  });

  it('blocks deleting a user with resources and tombstones an empty user', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await groupsPgFixture(fixture, {
        actorCapabilities: Object.values(Capability),
      });
      await dependency(fixture, context.userId, context.serverId, 'container');
      await expect(context.service.deleteUserPermanently(
        context.userId,
        context.actorId,
      )).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'USER_DELETE_HAS_RESOURCES' }),
      });
      await fixture.database.deleteFrom('control.authorization_dependencies')
        .where('user_id', '=', context.userId)
        .execute();
      await expect(context.service.deleteUserPermanently(
        context.userId,
        context.actorId,
      )).resolves.toEqual({ deleted: true, taskIds: [] });
      expect(await fixture.database.selectFrom('iam.users')
        .select('status')
        .where('id', '=', context.userId)
        .executeTakeFirst()).toMatchObject({ status: UserStatus.Deleted });
    });
  });

  it('drains known quota to zero and tombstones only after Agent proof finalizes', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await groupsPgFixture(fixture, {
        actorCapabilities: Object.values(Capability),
      });
      await context.service.upsertUserServerGrant(
        context.userId,
        context.serverId,
        { diskBytes: 4096 },
        context.actorId,
      );
      const deleting = await context.service.deleteUserPermanently(
        context.userId,
        context.actorId,
      );
      expect(deleting).toMatchObject({ deleted: false, taskIds: [expect.any(String)] });
      expect(await fixture.database.selectFrom('iam.users')
        .select('status')
        .where('id', '=', context.userId)
        .executeTakeFirst()).toMatchObject({ status: UserStatus.Deleting });

      const codec = new AgentTaskPayloadCodecService({
        decryptIfEncrypted: (value: string) => value,
      } as never);
      const repository = new WorkflowRepository(
        fixture.database,
        context.transactions,
        codec,
      );
      const registry = new WorkflowFinalizerRegistry();
      new QuotaWorkflowFinalizerService(registry, context.storage).onModuleInit();
      const dispatch = new WorkflowDispatchService(repository, codec, registry);
      const agentSession = await createReadyAgentSession(
        repository,
        context.serverId,
      );
      const claimed = await dispatch.claimAndBuild(
        context.serverId,
        agentSession,
      );
      expect(claimed?.claim.task.id).toBe(deleting.taskIds[0]);
      await dispatch.markSent(claimed!);
      const task = await repository.findTask(deleting.taskIds[0]!);
      await repository.acceptAgentResult(context.serverId, {
        taskId: task!.id,
        payloadHash: task!.payloadHash,
        status: 'succeeded',
        result: { numericUserId: 1002, hardLimitBytes: 0 },
      }, agentSession);
      expect(await new WorkflowFinalizerWorkerService(repository, registry).process()).toBe(1);
      expect(await fixture.database.selectFrom('iam.users')
        .select('status')
        .where('id', '=', context.userId)
        .executeTakeFirst()).toMatchObject({ status: UserStatus.Deleted });
      expect(await context.storage.findQuotaDesired(
        context.serverId,
        context.userId,
      )).toBeNull();
      expect(await repository.findTask(task!.id)).toMatchObject({
        kind: AgentTaskKind.QuotaEnsure,
        status: 'succeeded',
      });
    });
  });
});

function directGrant(userId: string, serverId: string, diskBytes: number) {
  return {
    id: randomUUID(),
    user_id: userId,
    group_id: null,
    server_id: serverId,
    cpu_millis: 1000,
    mem_bytes: 1024,
    disk_bytes: diskBytes,
    gpu_mode: GpuGrantMode.None,
    gpu_indices: null,
  };
}

/**
 * Mirrors the shapes the real writers produce: container rows carry no mount
 * source, while a data directory always resolves to an exact local or remote one.
 */
async function dependency(
  fixture: PostgresTestDatabase,
  userId: string,
  serverId: string,
  kind: string,
) {
  const local = kind === 'data_directory' || kind === 'container_mount';
  await fixture.database.insertInto('control.authorization_dependencies').values({
    id: randomUUID(),
    dependency_kind: kind,
    dependency_id: randomUUID(),
    user_id: userId,
    server_id: serverId,
    source_kind: local ? 'local' : null,
    source_id: local ? 'disk-a' : null,
    source_identity: local ? 'local:xfs:00000000-0000-0000-0000-000000000001:fsroot=%2F' : null,
  }).execute();
}
