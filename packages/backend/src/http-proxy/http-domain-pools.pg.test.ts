import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Role } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import {
  seedContainer,
  seedImage,
  seedPool,
  seedServer,
  seedUser,
} from '../iam/access.pg-test-helper.js';
import { testActor } from '../iam/actor.test-helper.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { HttpDomainPoolsService } from './http-domain-pools.service.js';
import { HttpProxyBindingsService } from './http-proxy-bindings.service.js';
import { HttpProxyTrafficService } from './http-proxy-traffic.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function errorCode(code: string) {
  return expect.objectContaining({
    getResponse: expect.any(Function),
    response: expect.objectContaining({ code }),
  });
}

describePg('HTTP domain pools stay disjoint (PostgreSQL)', () => {
  it('refuses nested pools and hostnames that are a parent of a pool', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const transactions = new PgTransactionManager(database);
      const audit = { append: async () => undefined } as never;
      const pools = new HttpDomainPoolsService(
        database,
        transactions,
        { keyEncryptionSecret: () => 'k'.repeat(32) } as never,
        audit,
      );
      const bindings = new HttpProxyBindingsService(
        database,
        transactions,
        audit,
        new HttpProxyTrafficService(database),
      );
      const adminId = await seedUser(database, 'pool-admin', undefined, Role.Admin);
      const ownerId = await seedUser(database, 'pool-tenant');
      const serverId = await seedServer(database);
      const poolId = await seedPool(database, serverId);
      const imageId = await seedImage(database);
      const containerId = await seedContainer(database, { ownerId, serverId, poolId, imageId });

      const outer = await pools.createDomainPool(adminId, { wildcardDomain: '*.example.test' });
      const sibling = await pools.createDomainPool(adminId, { wildcardDomain: '*.deep.example.org' });
      await expect(pools.createDomainPool(adminId, { wildcardDomain: '*.a.example.test' }))
        .rejects.toEqual(expect.any(ConflictException));
      await expect(pools.createDomainPool(adminId, { wildcardDomain: '*.a.example.test' }))
        .rejects.toEqual(errorCode('HTTP_PROXY_DOMAIN_POOL_OVERLAP'));
      // A pool that would contain an existing one is refused too.
      await expect(pools.createDomainPool(adminId, { wildcardDomain: '*.example.org' }))
        .rejects.toEqual(errorCode('HTTP_PROXY_DOMAIN_POOL_OVERLAP'));
      await expect(pools.createDomainPool(adminId, { wildcardDomain: '*.example.test' }))
        .rejects.toEqual(errorCode('HTTP_PROXY_DOMAIN_POOL_EXISTS'));
      // Moving a pool under another is the same conflict; a disjoint rename is fine.
      await expect(pools.updateDomainPool(adminId, sibling.id, { wildcardDomain: '*.b.example.test' }))
        .rejects.toEqual(errorCode('HTTP_PROXY_DOMAIN_POOL_OVERLAP'));
      await expect(pools.updateDomainPool(adminId, sibling.id, { wildcardDomain: '*.example.net' }))
        .resolves.toEqual(expect.objectContaining({ wildcardDomain: '*.example.net' }));

      // A pool nested by hand (e.g. created before this check) still cannot be
      // reached through a binding on its parent domain.
      await database.insertInto('interaction.http_domain_pools')
        .values({
          id: randomUUID(),
          wildcard_domain: '*.a.example.test',
          enabled: false,
          https_enabled: false,
        })
        .execute();
      const owner = testActor(ownerId);
      await expect(bindings.createBinding(owner, {
        hostname: 'a.example.test', containerId, targetPort: 8000,
      })).rejects.toEqual(expect.any(BadRequestException));
      await expect(bindings.createBinding(owner, {
        hostname: 'a.example.test', containerId, targetPort: 8000,
      })).rejects.toEqual(errorCode('HTTP_PROXY_HOSTNAME_COVERS_DOMAIN_POOL'));
      const binding = await bindings.createBinding(owner, {
        hostname: 'web.example.test', containerId, targetPort: 8000,
      });
      expect(binding.domainPoolId).toBe(outer.id);
      await expect(bindings.updateBinding(owner, binding.id, { hostname: 'a.example.test' }))
        .rejects.toEqual(errorCode('HTTP_PROXY_HOSTNAME_COVERS_DOMAIN_POOL'));
    });
  });
});
