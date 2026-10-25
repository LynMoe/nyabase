import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { HttpProxyStatusReport } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import {
  seedContainer,
  seedImage,
  seedPool,
  seedServer,
  seedUser,
} from '../iam/access.pg-test-helper.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { HttpProxyTrafficService } from './http-proxy-traffic.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

async function seedBindings(database: Kysely<NyabaseDatabase>, count: number): Promise<string[]> {
  const ownerId = await seedUser(database, `traffic-${randomUUID().slice(0, 8)}`);
  const serverId = await seedServer(database);
  const poolId = await seedPool(database, serverId);
  const imageId = await seedImage(database);
  const containerId = await seedContainer(database, { ownerId, serverId, poolId, imageId });
  const domainPoolId = randomUUID();
  await database.insertInto('interaction.http_domain_pools')
    .values({ id: domainPoolId, wildcard_domain: '*.apps.example.test', enabled: true, https_enabled: false })
    .execute();
  const ids = Array.from({ length: count }, () => randomUUID());
  await database.insertInto('interaction.http_proxy_bindings')
    .values(ids.map((id, index) => ({
      id,
      hostname: `site-${index}.apps.example.test`,
      domain_pool_id: domainPoolId,
      owner_id: ownerId,
      container_id: containerId,
      target_port: 8000,
    })))
    .execute();
  return ids;
}

function report(
  instanceId: string | undefined,
  bindings: Array<[string, number, number, number, number?]>,
  proxyId = 'http-proxy-1',
): HttpProxyStatusReport {
  return {
    proxyId,
    instanceId,
    hostname: null,
    httpListen: '0.0.0.0:80',
    httpsListen: null,
    uptimeMs: 1,
    connectedAt: 1,
    lastSnapshotGeneration: null,
    lastSnapshotAt: null,
    activeConnections: 0,
    totalRequests: 0,
    totalRejectedRequests: 0,
    bindings: bindings.map(([bindingId, requests, rxBytes, txBytes, active]) => ({
      bindingId,
      requests,
      activeConnections: active ?? 0,
      rxBytes,
      txBytes,
    })),
  };
}

async function totals(service: HttpProxyTrafficService, id: string) {
  const stats = (await service.statsFor([id])).get(id)!;
  return [stats.totalRequests, stats.totalRxBytes, stats.totalTxBytes];
}

describePg('HttpProxyTrafficService (PostgreSQL)', () => {
  it('stores raw counters per instance, idempotently across reconnects and Backend restarts', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const [a, b] = await seedBindings(database, 2);
      const service = new HttpProxyTrafficService(database);
      const first = {};
      service.record(first, report('instance-one', [[a!, 3, 300, 3_000, 1], [b!, 1, 10, 20]]));
      await service.settled();
      expect(await totals(service, a!)).toEqual([3, 300, 3_000]);
      expect((await service.statsFor([a!])).get(a!)?.activeConnections).toBe(1);

      // Within the write interval the newer counts are overlaid, not yet stored.
      service.record(first, report('instance-one', [[a!, 5, 500, 5_000], [b!, 1, 10, 20]]));
      await service.settled();
      expect(await totals(service, a!)).toEqual([5, 500, 5_000]);
      const stored = await database.selectFrom('interaction.http_proxy_binding_counters')
        .select('requests').where('binding_id', '=', a!).executeTakeFirstOrThrow();
      expect(stored.requests).toBe('3');

      // The disconnect flushes them; the same instance on a new link
      // resends the same cumulative values without double counting.
      service.forget(first);
      await service.settled();
      expect((await service.statsFor([a!])).get(a!)?.activeConnections).toBe(0);
      service.record({}, report('instance-one', [[a!, 5, 500, 5_000]]));
      await service.settled();
      expect(await totals(service, a!)).toEqual([5, 500, 5_000]);

      // A restarted Backend knows nothing in memory; the raw counters still
      // replace, not add to, what the instance stored.
      const restarted = new HttpProxyTrafficService(database);
      restarted.record({}, report('instance-one', [[a!, 6, 600, 6_000]]));
      // A restarted proxy is a new instance whose counters start from zero.
      restarted.record({}, report('instance-two', [[a!, 2, 20, 200]]));
      // A proxy without per-binding counters is simply not counted.
      restarted.record({}, report(undefined, [[a!, 100, 100, 100]]));
      await restarted.settled();
      expect(await totals(restarted, a!)).toEqual([8, 620, 6_200]);
      expect(await totals(restarted, b!)).toEqual([1, 10, 20]);
    });
  });

  it('ignores ids that are not bindings and drops counters with their binding', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const [a] = await seedBindings(database, 1);
      const service = new HttpProxyTrafficService(database);
      service.record({}, report('instance-one', [
        [a!, 1, 1, 1],
        [randomUUID(), 1, 1, 1],
        ['not-a-uuid', 1, 1, 1],
      ]));
      await service.settled();
      expect(await totals(service, a!)).toEqual([1, 1, 1]);
      await database.deleteFrom('interaction.http_proxy_bindings').where('id', '=', a!).execute();
      const rows = await database.selectFrom('interaction.http_proxy_binding_counters')
        .selectAll().execute();
      expect(rows).toEqual([]);
    });
  });

  it('folds instances silent for a day into one archived row and never counts them again', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const [a, b] = await seedBindings(database, 2);
      const service = new HttpProxyTrafficService(database);
      const oldLink = {};
      service.record(oldLink, report('old', [[a!, 10, 100, 1_000], [b!, 1, 1, 1]], 'proxy-a'));
      service.record({}, report('older', [[a!, 20, 200, 2_000]], 'proxy-b'));
      service.record({}, report('connected', [[a!, 1, 1, 1]], 'proxy-c'));
      await service.settled();
      service.forget(oldLink);
      await service.settled();
      await database.updateTable('interaction.http_proxy_counter_instances')
        .set({ last_seen_at: sql<Date>`now() - interval '2 days'` })
        .execute();

      await service.archiveStaleInstances(['proxy-b:older']);
      const rows = await database.selectFrom('interaction.http_proxy_binding_counters')
        .select(['proxy_instance', 'binding_id', 'requests'])
        .orderBy('proxy_instance').orderBy('binding_id')
        .execute();
      expect(rows.map((row) => [row.proxy_instance, row.binding_id, row.requests]).sort())
        .toEqual([
          ['archived', a!, '11'],
          ['archived', b!, '1'],
          ['proxy-b:older', a!, '20'],
        ].sort());
      expect(await totals(service, a!)).toEqual([31, 301, 3_001]);

      // Folding again adds into the archived row.
      await service.archiveStaleInstances([]);
      expect(await totals(service, a!)).toEqual([31, 301, 3_001]);
      const archived = await database.selectFrom('interaction.http_proxy_binding_counters')
        .select('requests').where('proxy_instance', '=', 'archived').where('binding_id', '=', a!)
        .executeTakeFirstOrThrow();
      expect(archived.requests).toBe('31');

      // An archived instance that reports again is not counted twice.
      const revived = new HttpProxyTrafficService(database);
      revived.record({}, report('old', [[a!, 12, 120, 1_200]], 'proxy-a'));
      await revived.settled();
      expect(await totals(revived, a!)).toEqual([31, 301, 3_001]);
    });
  });
});
