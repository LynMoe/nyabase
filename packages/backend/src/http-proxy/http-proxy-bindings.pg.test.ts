import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Role, UserStatus } from '@nyabase/common';
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
import { HttpProxyBindingsService } from './http-proxy-bindings.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('HttpProxyBindingsService ownership (PostgreSQL)', () => {
  it("answers another user's binding and container like missing ones (404, not 403)", async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const service = new HttpProxyBindingsService(
        database,
        new PgTransactionManager(database),
        { append: async () => undefined } as never,
      );
      const ownerId = await seedUser(database, 'binding-owner');
      const otherId = await seedUser(database, 'binding-other');
      const operatorId = await seedUser(database, 'binding-operator', UserStatus.Active, Role.Operator);
      const serverId = await seedServer(database);
      const poolId = await seedPool(database, serverId);
      const imageId = await seedImage(database);
      const containerId = await seedContainer(database, { ownerId, serverId, poolId, imageId });
      const otherContainerId = await seedContainer(database, { ownerId: otherId, serverId, poolId, imageId });
      await database.insertInto('interaction.http_domain_pools')
        .values({ id: randomUUID(), wildcard_domain: '*.apps.example.test', enabled: true, https_enabled: false })
        .execute();
      const owner = testActor(ownerId);
      const other = testActor(otherId);
      const binding = await service.createBinding(owner, {
        hostname: 'web.apps.example.test', containerId, targetPort: 8000,
      });

      const notFound = expect.any(NotFoundException);
      await expect(service.updateBinding(other, binding.id, { targetPort: 9000 })).rejects.toEqual(notFound);
      await expect(service.deleteBinding(other, binding.id)).rejects.toEqual(notFound);
      await expect(service.updateBinding(other, randomUUID(), { targetPort: 9000 })).rejects.toEqual(notFound);
      // Pointing a binding at someone else's container is the same 404.
      await expect(service.createBinding(other, {
        hostname: 'steal.apps.example.test', containerId, targetPort: 8000,
      })).rejects.toEqual(notFound);
      await expect(service.updateBinding(owner, binding.id, { containerId: otherContainerId }))
        .rejects.toEqual(notFound);
      // Nothing moved.
      await expect(service.listBindings(owner, 'mine', true)).resolves.toEqual([
        expect.objectContaining({ id: binding.id, targetPort: 8000, containerId }),
      ]);

      // The explicit operator override still reaches it.
      await service.deleteBinding(testActor(operatorId, Role.Operator), binding.id, 'all');
      await expect(service.listBindings(owner, 'mine', true)).resolves.toEqual([]);
    });
  });

  it('keeps an unchanged hostname through edits even when its pool rules would now refuse it', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const service = new HttpProxyBindingsService(
        database,
        new PgTransactionManager(database),
        { append: async () => undefined } as never,
      );
      const ownerId = await seedUser(database, 'binding-editor');
      const otherId = await seedUser(database, 'binding-bystander');
      const serverId = await seedServer(database);
      const poolId = await seedPool(database, serverId);
      const imageId = await seedImage(database);
      const containerId = await seedContainer(database, { ownerId, serverId, poolId, imageId });
      const nextContainerId = await seedContainer(database, { ownerId, serverId, poolId, imageId });
      const otherContainerId = await seedContainer(database, { ownerId: otherId, serverId, poolId, imageId });
      const domainPoolId = randomUUID();
      await database.insertInto('interaction.http_domain_pools')
        .values({ id: domainPoolId, wildcard_domain: '*.apps.example.test', enabled: true, https_enabled: false })
        .execute();
      const owner = testActor(ownerId);
      const binding = await service.createBinding(owner, {
        hostname: 'web.apps.example.test', containerId, targetPort: 8000,
      });
      // Since then the pool was disabled and a pool under the binding's
      // hostname appeared, so the hostname could not be claimed today.
      await database.updateTable('interaction.http_domain_pools')
        .set({ enabled: false })
        .where('id', '=', domainPoolId)
        .execute();
      await database.insertInto('interaction.http_domain_pools')
        .values({ id: randomUUID(), wildcard_domain: '*.web.apps.example.test', enabled: true, https_enabled: false })
        .execute();

      // The UI resends the hostname with every edit.
      await expect(service.updateBinding(owner, binding.id, {
        hostname: 'web.apps.example.test', containerId: nextContainerId, targetPort: 9000,
      })).resolves.toEqual(expect.objectContaining({
        hostname: 'web.apps.example.test', domainPoolId, containerId: nextContainerId, targetPort: 9000,
      }));
      await expect(service.updateBinding(owner, binding.id, { hostname: 'WEB.apps.example.test' }))
        .resolves.toEqual(expect.objectContaining({ hostname: 'web.apps.example.test', domainPoolId }));
      // Ownership still applies to the other fields.
      await expect(service.updateBinding(owner, binding.id, {
        hostname: 'web.apps.example.test', containerId: otherContainerId,
      })).rejects.toEqual(expect.any(NotFoundException));
      // A new hostname is still checked: the disabled pool takes none.
      await expect(service.updateBinding(owner, binding.id, { hostname: 'api.apps.example.test' }))
        .rejects.toEqual(expect.any(BadRequestException));
    });
  });
});
