import { describe, expect, it } from 'vitest';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { SshIdentityService } from './ssh-identity.service.js';
import { SshKeyCryptoService } from '../platform/ssh-key-crypto.service.js';
import { SshKeygenService } from './ssh-keygen.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function cryptoWith(secret: string): SshKeyCryptoService {
  return new SshKeyCryptoService({ keyEncryptionSecret: () => secret } as never);
}

describePg('SshIdentityService host key recovery', () => {
  it('rotates a host key that the current secret can no longer decrypt', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const transactions = new PgTransactionManager(database);
      const keygen = new SshKeygenService();
      const before = new SshIdentityService(database, transactions, keygen, cryptoWith('old-secret-old-secret-old-secret'));
      const original = await before.ensureProxyHostKey();

      // The deployment lost or changed ssh.keyEncryptionSecret.
      const after = new SshIdentityService(database, transactions, keygen, cryptoWith('new-secret-new-secret-new-secret'));
      await expect(after.ensureProxyHostKey()).rejects.toThrow();
      await expect(after.getProxyHostKeySummary()).resolves.toMatchObject({ generation: 1 });

      const rotated = await after.rotateProxyHostKey(async () => undefined);
      expect(rotated.generation).toBe(original.generation + 1);
      await expect(after.ensureProxyHostKey()).resolves.toMatchObject({
        generation: 2,
        privateKey: rotated.privateKey,
      });
    });
  });
});
