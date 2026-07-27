import { randomUUID } from 'node:crypto';
import { ServerStatus } from '@nyabase/common';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import {
  withPostgresTestDatabase,
} from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { AgentSessionLockDatabase } from './agent-session-lock-database.js';
import { WorkflowRepository } from './workflow.repository.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('AgentSessionLockDatabase runtime isolation', () => {
  it('handles idle pool errors through the authority fail-stop boundary', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const failStop = { terminate: vi.fn() };
      const runtime = repositoryRuntime(fixture.connectionString, failStop);
      try {
        const pool = (runtime.sessionLocks as unknown as { pool: Pool }).pool;
        const error = Object.assign(new Error('idle authority socket lost'), {
          code: '57P01',
        });

        expect(() => pool.emit('error', error)).not.toThrow();
        expect(failStop.terminate).toHaveBeenCalledWith(expect.objectContaining({
          message: 'Agent session lock database pool lost a connection',
          cause: error,
        }));
      } finally {
        await runtime.destroy();
      }
    });
  });

  it('keeps a max=1 main pool usable while all four dedicated lock connections wait', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const runtime = repositoryRuntime(fixture.connectionString);
      const control = new Pool({
        connectionString: fixture.connectionString,
        application_name: 'lock-proof-control',
        max: 5,
      });
      const blockers: PoolClient[] = [];
      try {
        const bindings = [];
        for (let index = 0; index < 4; index += 1) {
          const serverId = await seedServer(runtime.database, index);
          bindings.push(await readyAgentSession(runtime.repository, serverId));
        }
        for (const binding of bindings) {
          const client = await control.connect();
          blockers.push(client);
          await client.query(
            `SELECT pg_advisory_lock(
               hashtext('nyabase-agent-session'),
               hashtext($1)
             )`,
            [binding.serverId],
          );
        }

        const bridges = bindings.map((binding) =>
          runtime.repository.runWithAgentSessionSendFence(binding, async () => true));
        await vi.waitFor(async () => {
          const waiting = await control.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM pg_stat_activity
             WHERE datname = current_database()
               AND application_name = 'lock-proof-agent-session-lock'
               AND wait_event_type = 'Lock'`,
          );
          expect(waiting.rows[0]?.count).toBe('4');
        });

        await expect(runtime.database.selectFrom('iam.policy_state')
          .select('policy_epoch')
          .executeTakeFirstOrThrow()).resolves.toMatchObject({
          policy_epoch: expect.any(String),
        });

        for (let index = 0; index < blockers.length; index += 1) {
          await blockers[index]!.query(
            `SELECT pg_advisory_unlock(
               hashtext('nyabase-agent-session'),
               hashtext($1)
             )`,
            [bindings[index]!.serverId],
          );
        }
        await expect(Promise.all(bridges)).resolves.toEqual([true, true, true, true]);
      } finally {
        for (const blocker of blockers) blocker.release();
        await control.end();
        await runtime.destroy();
      }
    });
  });

  it('fail-stops when PostgreSQL kills the connection carrying exact send authority', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const failStop = { terminate: vi.fn() };
      const runtime = repositoryRuntime(fixture.connectionString, failStop);
      const control = new Pool({
        connectionString: fixture.connectionString,
        application_name: 'lock-proof-control',
        max: 1,
      });
      try {
        const serverId = await seedServer(runtime.database, 10);
        const binding = await readyAgentSession(runtime.repository, serverId);
        const entered = deferred<number>();
        const never = deferred<void>();
        const bridge = runtime.repository.runWithAgentSessionSendFence(
          binding,
          async (connection) => {
            const pid = await sql<{ pid: number }>`
              SELECT pg_backend_pid()::integer AS pid
            `.execute(connection);
            entered.resolve(pid.rows[0]!.pid);
            await never.promise;
            return true;
          },
        );
        const pid = await entered.promise;

        await control.query('SELECT pg_terminate_backend($1)', [pid]);
        await expect(bridge).rejects.toThrow();
        expect(failStop.terminate).toHaveBeenCalled();
        expect(failStop.terminate.mock.calls.some(([error]) =>
          error instanceof Error
          && (
            error.name === 'AgentAuthorityBridgeLostError'
            || error.message.includes('lock database connection lost')
          ))).toBe(true);
      } finally {
        await control.end();
        await runtime.destroy();
      }
    });
  }, 10_000);
});

function repositoryRuntime(
  connectionString: string,
  failStop: { terminate(error: unknown): unknown } = { terminate: vi.fn() },
) {
  const pool = new Pool({
    connectionString,
    application_name: 'lock-proof-main',
    max: 1,
  });
  const database = new Kysely<NyabaseDatabase>({
    dialect: new PostgresDialect({ pool }),
  });
  const sessionLocks = new AgentSessionLockDatabase({
    connectionString,
    applicationName: 'lock-proof',
    poolMax: 1,
    connectionTimeoutMs: 2_000,
    idleTimeoutMs: 5_000,
    statementTimeoutMs: 5_000,
    lockTimeoutMs: 5_000,
    idleInTransactionTimeoutMs: 5_000,
    readinessTimeoutMs: 5_000,
    ssl: false,
    runMigrationsOnStart: false,
  }, failStop as never);
  const repository = new WorkflowRepository(
    database,
    new PgTransactionManager(database),
    undefined,
    failStop as never,
    sessionLocks,
  );
  return {
    database,
    repository,
    sessionLocks,
    async destroy() {
      await sessionLocks.onApplicationShutdown().catch(() => undefined);
      await database.destroy().catch(() => undefined);
    },
  };
}

async function seedServer(
  database: Kysely<NyabaseDatabase>,
  index: number,
): Promise<string> {
  const id = randomUUID();
  await database.insertInto('infra.servers').values({
    id,
    name: `Lock node ${index}`,
    slug: `lock-node-${index}-${id.slice(0, 8)}`,
    agent_token_hash: id.replaceAll('-', '').padEnd(64, String(index % 10)),
    host_fingerprint: null,
    agent_config_fingerprint: null,
    status: ServerStatus.Online,
    quarantine_code: null,
    quarantine_message: null,
    last_seen_at: null,
    macvlan_cidr: null,
    macvlan_gateway: null,
    macvlan_reserved_ips: '[]',
    revision: 1,
  }).execute();
  return id;
}

async function readyAgentSession(
  repository: WorkflowRepository,
  serverId: string,
) {
  const id = randomUUID();
  const gatewayId = `gateway:${id}`;
  const admitted = await repository.admitAgentSession({
    id,
    serverId,
    sessionToken: `token:${id}`,
    hostFingerprint: `host:${id}`,
    configFingerprint: `config:${id}`,
    gatewayId,
  });
  await repository.markAgentSessionReady(
    serverId,
    id,
    admitted.generation,
    gatewayId,
  );
  return {
    serverId,
    id,
    generation: admitted.generation,
    gatewayId,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
