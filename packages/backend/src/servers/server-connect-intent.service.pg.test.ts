import { describe, expect, it } from 'vitest';
import { EphemeralStore } from '../platform/ephemeral-store.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { noopWake } from '../reconcile/reconcile-wake.test-helper.js';
import { insertServerFixture } from '../reconcile/server-fixture.test-helper.js';
import { ServerConnectIntentService } from './server-connect-intent.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('ServerConnectIntentService (PostgreSQL)', () => {
  it('persists only a trust-token reference for server.connect intents', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await insertServerFixture(database);
      const ephemeral = new EphemeralStore();
      try {
        const service = new ServerConnectIntentService(
          new IntentRepository(database, noopWake()),
          ephemeral,
        );
        const intent = await service.create({
          serverId,
          trustToken: 'one-time-secret',
          targetRevision: 1,
        });
        const row = await database
          .selectFrom('control.intents')
          .select('request_json')
          .where('id', '=', intent.id)
          .executeTakeFirstOrThrow();
        expect(Object.keys(row.request_json as object)).toEqual(['trustTokenRef']);
        expect(JSON.stringify(row.request_json)).not.toContain('one-time-secret');
        expect(ephemeral.claimTrustToken(
          serverId,
          String(intent.request?.trustTokenRef),
          'claim-1',
        )).toBe('one-time-secret');
      } finally {
        ephemeral.onApplicationShutdown();
      }
    });
  });
});
