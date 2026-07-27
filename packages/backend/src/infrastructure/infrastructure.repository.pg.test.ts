import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ServerStatus } from '@nyabase/common';
import {
  withPostgresTestDatabase,
} from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { InfrastructureRepository } from './infrastructure.repository.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;
const runtimeOverrides = {
  uid: 0,
  entrypoint: null,
  cmd: null,
  init: false,
};

describePg('InfrastructureRepository PostgreSQL integration', () => {
  it('enforces server identity and image ownership constraints in PostgreSQL', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const repository = new InfrastructureRepository(database);
      const serverId = randomUUID();
      await repository.insertServer({
        id: serverId,
        name: 'primary',
        slug: 'primary',
        agentTokenHash: 'a'.repeat(64),
      });

      await expect(repository.insertServer({
        id: randomUUID(),
        name: 'duplicate slug',
        slug: 'primary',
        agentTokenHash: 'b'.repeat(64),
      })).rejects.toMatchObject({ code: '23505' });
      await expect(repository.insertServer({
        id: randomUUID(),
        name: 'bad slug',
        slug: 'Bad Slug',
        agentTokenHash: 'c'.repeat(64),
      })).rejects.toMatchObject({ code: '23514' });

      const image = await repository.insertImage({
        id: randomUUID(),
        name: 'base',
        dockerImage: 'registry.example/base:1',
        runtimeOverrides,
        description: null,
        isActive: true,
        disableSsh: false,
      });
      await expect(database.updateTable('infra.images')
        .set({ docker_image: 'registry.example/base:2' })
        .where('id', '=', image.id)
        .execute()).rejects.toMatchObject({ code: '23514' });
      await expect(repository.insertImage({
        id: randomUUID(),
        name: 'other',
        dockerImage: image.dockerImage,
        runtimeOverrides,
        description: null,
        isActive: true,
        disableSsh: false,
      })).rejects.toMatchObject({ code: '23505' });
    });
  });

  it('admits exactly one host identity and persists quarantine state', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const repository = new InfrastructureRepository(database);
      const server = await repository.insertServer({
        id: randomUUID(),
        name: 'agent host',
        slug: 'agent-host',
        agentTokenHash: 'd'.repeat(64),
      });
      const attempts = await Promise.all([
        repository.admitAgent(server.id, {
          hostFingerprint: 'host-a',
          agentConfigFingerprint: 'config-a',
          status: ServerStatus.Online,
          lastSeenAt: new Date(),
        }),
        repository.admitAgent(server.id, {
          hostFingerprint: 'host-b',
          agentConfigFingerprint: 'config-b',
          status: ServerStatus.Online,
          lastSeenAt: new Date(),
        }),
      ]);
      expect(attempts.filter(Boolean)).toHaveLength(1);
      const bound = await repository.findServerById(server.id);
      expect(['host-a', 'host-b']).toContain(bound?.hostFingerprint);

      const quarantined = await repository.quarantineServer(
        server.id,
        'AGENT_INVENTORY_FAULT',
        'inventory rejected',
      );
      expect(quarantined).toMatchObject({
        status: ServerStatus.AgentQuarantined,
        quarantineCode: 'AGENT_INVENTORY_FAULT',
        quarantineMessage: 'inventory rejected',
      });
    });
  });

  it('allows only one concurrent image CAS winner', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const repository = new InfrastructureRepository(database);
      const image = await repository.insertImage({
        id: randomUUID(),
        name: 'cas',
        dockerImage: 'registry.example/cas:1',
        runtimeOverrides,
        description: null,
        isActive: true,
        disableSsh: false,
      });
      const results = await Promise.all([
        repository.updateImageCas(image.id, image.revision, { description: 'first' }),
        repository.updateImageCas(image.id, image.revision, { description: 'second' }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await repository.findImageById(image.id))?.revision).toBe(2);
    });
  });

  it('coalesces liveness timestamps without churning unchanged server revisions', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const repository = new InfrastructureRepository(database);
      const server = await repository.insertServer({
        id: randomUUID(),
        name: 'heartbeat',
        slug: 'heartbeat',
        agentTokenHash: 'f'.repeat(64),
      });

      const online = await repository.updateServerLiveness(
        server.id,
        ServerStatus.Online,
      );
      const onlineRevision = Number((await database
        .selectFrom('infra.servers')
        .select('revision')
        .where('id', '=', server.id)
        .executeTakeFirstOrThrow()).revision);
      expect(onlineRevision).toBe(2);
      const firstSeenAt = online?.lastSeenAt?.getTime() ?? 0;

      await new Promise((resolve) => setTimeout(resolve, 5));
      const unchanged = await repository.updateServerLiveness(
        server.id,
        ServerStatus.Online,
      );
      const unchangedRevision = Number((await database
        .selectFrom('infra.servers')
        .select('revision')
        .where('id', '=', server.id)
        .executeTakeFirstOrThrow()).revision);
      expect(unchangedRevision).toBe(onlineRevision);
      expect(unchanged?.lastSeenAt?.getTime()).toBeGreaterThan(firstSeenAt);

      const offline = await repository.updateServerLiveness(
        server.id,
        ServerStatus.Offline,
      );
      const offlineRevision = Number((await database
        .selectFrom('infra.servers')
        .select('revision')
        .where('id', '=', server.id)
        .executeTakeFirstOrThrow()).revision);
      expect(offline?.status).toBe(ServerStatus.Offline);
      expect(offlineRevision).toBe(unchangedRevision + 1);
    });
  });

  it('rolls back infrastructure mutations with the caller transaction', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const repository = new InfrastructureRepository(database);
      const transactions = new PgTransactionManager(database);
      const serverId = randomUUID();
      await expect(transactions.run(async (transaction) => {
        await repository.insertServer({
          id: serverId,
          name: 'rollback',
          slug: 'rollback',
          agentTokenHash: 'e'.repeat(64),
        }, transaction);
        throw new Error('rollback requested');
      })).rejects.toThrow('rollback requested');
      expect(await repository.findServerById(serverId)).toBeNull();
    });
  });
});
