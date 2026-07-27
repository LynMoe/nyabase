import { randomUUID } from 'node:crypto';
import { ServerStatus } from '@nyabase/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { InfrastructureRepository } from '../infrastructure/infrastructure.repository.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { ServersService } from './servers.service.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('ServersService bulk projection query bound', () => {
  it('projects 128 server DTOs with exactly one PostgreSQL query', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      await fixture.database.insertInto('infra.servers').values(
        Array.from({ length: 128 }, (_, index) => ({
          id: randomUUID(),
          name: `Node ${String(index).padStart(3, '0')}`,
          slug: `node-${index}`,
          agent_token_hash: `${index}`.padStart(64, '0'),
          host_fingerprint: null,
          agent_config_fingerprint: null,
          status: ServerStatus.Online,
          quarantine_code: null,
          quarantine_message: null,
          last_seen_at: new Date('2026-01-01T00:00:00Z'),
          macvlan_cidr: null,
          macvlan_gateway: null,
          macvlan_reserved_ips: JSON.stringify([]),
          revision: 1,
        })),
      ).execute();

      let queryCount = 0;
      const pool = new Pool({ connectionString: fixture.connectionString, max: 1 });
      pool.on('error', () => undefined);
      const database = new Kysely<NyabaseDatabase>({
        dialect: new PostgresDialect({ pool }),
        log: (event) => {
          if (event.level === 'query') queryCount += 1;
        },
      });
      const infrastructure = new InfrastructureRepository(database);
      const service = new ServersService(
        infrastructure,
        {
          stateCache: {
            get: vi.fn().mockReturnValue(undefined),
            getAll: vi.fn().mockReturnValue([]),
          },
        } as unknown as AgentGateway,
        {} as never,
        {} as never,
        new PgTransactionManager(database),
        {} as never,
        {} as never,
        {} as never,
      );
      try {
        queryCount = 0;
        const result = await service.findAllDtos();
        expect(queryCount).toBe(1);
        expect(result).toHaveLength(128);
        expect(result.every((row) => row.disks?.length === 0)).toBe(true);
      } finally {
        await database.destroy();
      }
    });
  });
});
