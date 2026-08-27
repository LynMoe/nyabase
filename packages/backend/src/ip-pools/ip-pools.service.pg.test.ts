import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { FailureCode, UserStatus } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { IpPoolsRepository } from './ip-pools.repository.js';
import { IpPoolsService } from './ip-pools.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('IP pools', () => {
  it('creates a shared pool, rejects overlaps, and blocks delete while claimed', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actorId = randomUUID();
      const serverA = randomUUID();
      const serverB = randomUUID();
      await seedUser(database, actorId);
      await seedServer(database, serverA, 'ip-pool-a');
      await seedServer(database, serverB, 'ip-pool-b');
      const service = new IpPoolsService(
        new IpPoolsRepository(database),
        new PgTransactionManager(database),
        { append: vi.fn().mockResolvedValue(undefined) } as never,
        database,
      );

      const pool = await service.create(actorId, {
        name: 'shared-lan',
        cidr: '10.8.0.0/16',
        allocationCidr: '10.8.100.0/24',
        gateway: '10.8.0.1',
        reservedIps: ['10.8.0.1', '10.8.96.92'],
        serverIds: [serverA, serverB],
      });
      expect(pool.serverIds.sort()).toEqual([serverA, serverB].sort());
      expect(pool.allocationCidr).toBe('10.8.100.0/24');
      expect(pool.usableCount).toBe(254);

      await expect(service.create(actorId, {
        name: 'overlap',
        cidr: '10.8.100.0/25',
        allocationCidr: '10.8.100.0/25',
        gateway: '10.8.100.1',
        reservedIps: [],
        serverIds: [],
      })).rejects.toMatchObject({
        response: { code: FailureCode.IpPoolCidrConflict },
      });

      await database.insertInto('control.container_network_claims').values({
        id: randomUUID(),
        container_id: null,
        server_id: serverA,
        network_key: pool.cidr,
        address: '10.8.100.10',
        state: 'releasing',
        reusable_at: new Date(Date.now() + 60_000),
        owner_kind: 'runtime_cleanup',
        owner_id: randomUUID(),
        cleanup_payload_json: { reason: 'test' },
      }).execute();

      await expect(service.patch(actorId, pool.id, {
        expectedRevision: pool.revision,
        allocationCidr: '10.8.101.0/24',
      })).rejects.toMatchObject({
        response: { code: FailureCode.IpPoolInUse },
      });

      await expect(service.delete(actorId, pool.id)).rejects.toMatchObject({
        response: { code: FailureCode.IpPoolInUse },
      });
    });
  });
});

async function seedUser(database: Kysely<NyabaseDatabase>, id: string): Promise<void> {
  await database.insertInto('iam.users').values({
    id,
    numeric_id: 3001,
    username: `ip-pool-${id.slice(0, 8)}`,
    password_hash: 'unused',
    display_name: 'IP Pool Actor',
    status: UserStatus.Active,
    auth_version: 1,
    authz_version: 1,
  }).execute();
}

async function seedServer(
  database: Kysely<NyabaseDatabase>,
  id: string,
  slug: string,
): Promise<void> {
  await database.insertInto('infra.servers').values({
    id,
    name: slug,
    slug,
    api_endpoint: 'https://incus.example.test:8443',
    server_cert_fingerprint: null,
    incus_version: null,
    api_extensions: [],
    system_pool_id: null,
    storage_overcommit_ratio: 1,
    parent_interface: 'eth0',
    dns_servers: [],
    gpu_runtime_available: false,
    status: 'online',
    last_seen_at: null,
    last_error: null,
    revision: 1,
    node_metrics_endpoint: null,
    node_metrics_server_cert_fingerprint: null,
    node_metrics_token_ciphertext: null,
    node_metrics_token_fingerprint: null,
    node_metrics_status: 'unconfigured',
    node_metrics_last_success_at: null,
    node_metrics_outage_since: null,
    node_metrics_last_error: null,
    preflight_status: 'passed',
    preflight_checked_at: null,
    preflight_report: null,
  }).execute();
}
