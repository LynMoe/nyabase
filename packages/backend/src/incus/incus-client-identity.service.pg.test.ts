import { describe, expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { IncusClientIdentityService } from './incus-client-identity.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

const config = {
  keyEncryptionSecret: () => 'test-encryption-secret-0123456789',
} as never;

describePg('IncusClientIdentityService (PostgreSQL)', () => {
  it('generates one identity on first use even when several processes race', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const services = [1, 2, 3].map(() => new IncusClientIdentityService(database, config));
      const identities = await Promise.all(services.map((service) => service.get()));

      const rows = await database
        .selectFrom('system.incus_client_identity')
        .selectAll()
        .execute();
      expect(rows).toHaveLength(1);
      for (const identity of identities) {
        expect(identity.fingerprint).toBe(rows[0]!.fingerprint);
        expect(identity.certificatePem).toBe(rows[0]!.certificate_pem);
      }
      expect(rows[0]!.encrypted_private_key).not.toContain('PRIVATE KEY');
      expect(new X509Certificate(identities[0]!.certificatePem).fingerprint256)
        .toBe(identities[0]!.fingerprint);
      expect(identities[0]!.privateKeyPem).toContain('PRIVATE KEY');
      const tenYearsMs = 3650 * 24 * 60 * 60 * 1000;
      expect(identities[0]!.notAfter.getTime() - Date.now()).toBeGreaterThan(tenYearsMs - 2 * 24 * 3600 * 1000);
    });
  });

  it('reuses the stored identity across restarts and describes it without the key', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const first = await new IncusClientIdentityService(database, config).get();
      const restarted = new IncusClientIdentityService(database, config);
      const second = await restarted.get();
      expect(second.fingerprint).toBe(first.fingerprint);
      expect(second.privateKeyPem).toBe(first.privateKeyPem);

      const dto = await restarted.describe();
      expect(dto).toEqual({
        fingerprint: first.fingerprint,
        notAfter: first.notAfter.toISOString(),
        createdAt: first.createdAt.toISOString(),
      });
      expect(JSON.stringify(dto)).not.toContain('PRIVATE KEY');
    });
  });
});
