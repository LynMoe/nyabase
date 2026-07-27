import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { UserStatus } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { UserSshIdentityService } from '../users/user-ssh-identity.service.js';
import { SshIdentityService } from './ssh-identity.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('PostgreSQL SSH identity CAS', () => {
  it('rolls back host-key generation when required audit append fails', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      let sequence = 0;
      const service = new SshIdentityService(
        database,
        new PgTransactionManager(database),
        {
          generateEd25519: vi.fn(async () => pair(`host-audit-${++sequence}`)),
        } as never,
        fakeCrypto() as never,
      );
      const original = await service.ensureProxyHostKey();
      await expect(service.rotateProxyHostKey(
        async () => undefined,
        async () => {
          throw new Error('audit unavailable');
        },
      )).rejects.toThrow('audit unavailable');
      expect(await service.getProxyHostKey()).toMatchObject({
        generation: original.generation,
        fingerprint: original.fingerprint,
      });
    });
  });

  it('returns only the persisted singleton winner under concurrent initialization', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      let sequence = 0;
      const keygen = {
        generateEd25519: vi.fn(async () => {
          sequence += 1;
          return pair(`host-${sequence}`);
        }),
      };
      const crypto = fakeCrypto();
      const service = new SshIdentityService(
        database,
        new PgTransactionManager(database),
        keygen as never,
        crypto as never,
      );
      const [left, right] = await Promise.all([
        service.ensureProxyHostKey(),
        service.ensureProxyHostKey(),
      ]);
      expect(left).toMatchObject(right);
      expect(left.privateKey).toBe(
        crypto.decrypt(left.encryptedPrivateKey),
      );
      expect(await database.selectFrom('interaction.ssh_proxy_host_keys')
        .selectAll().execute()).toHaveLength(1);
    });
  });

  it('allows exactly one proxy-host rotation CAS winner', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      let sequence = 0;
      const bothStarted = deferred();
      const release = deferred();
      let rotationStarts = 0;
      const service = new SshIdentityService(
        database,
        new PgTransactionManager(database),
        {
          generateEd25519: vi.fn(async () => {
            sequence += 1;
            if (sequence > 1) {
              rotationStarts += 1;
              if (rotationStarts === 2) bothStarted.resolve();
              await release.promise;
            }
            return pair(`host-${sequence}`);
          }),
        } as never,
        fakeCrypto() as never,
      );
      await service.ensureProxyHostKey();
      const settling = Promise.allSettled([
        service.rotateProxyHostKey(async () => undefined),
        service.rotateProxyHostKey(async () => undefined),
      ]);
      await bothStarted.promise;
      release.resolve();
      const settled = await settling;
      expect(settled.filter((result) => result.status === 'fulfilled'))
        .toHaveLength(1);
      const rejected = settled.find((result) => result.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason)
        .toBeInstanceOf(ConflictException);
      expect(await database.selectFrom('interaction.ssh_proxy_host_keys')
        .select('generation').executeTakeFirstOrThrow()).toEqual({
        generation: 2,
      });
    });
  });

  it('allows exactly one user-key rotation and never resurrects a deleting user', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      await database.insertInto('iam.users').values({
        id: userId,
        numeric_id: 1001,
        username: 'alice',
        password_hash: 'hash',
        display_name: 'Alice',
        status: UserStatus.Active,
        auth_version: 0,
        authz_version: 0,
      }).execute();
      await database.insertInto('iam.user_internal_ssh_keys').values({
        user_id: userId,
        encrypted_private_key: 'enc:private-1',
        public_key: 'public-1',
        fingerprint: 'fingerprint-1',
        generation: 1,
        rotated_at: new Date(),
      }).execute();
      let sequence = 0;
      const bothStarted = deferred();
      const release = deferred();
      const audit = { log: vi.fn().mockResolvedValue(undefined), append: vi.fn() };
      audit.append.mockImplementation(
        async (_transaction: unknown, ...args: unknown[]) => audit.log(...args),
      );
      const service = new UserSshIdentityService(
        database,
        new PgTransactionManager(database),
        {
          generateEd25519: vi.fn(async () => {
            sequence += 1;
            if (sequence === 2) bothStarted.resolve();
            await release.promise;
            return pair(`user-${sequence}`);
          }),
        } as never,
        fakeCrypto() as never,
        audit as never,
      );
      const settling = Promise.allSettled([
        service.rotateUserKey(userId, randomUUID(), async () => undefined),
        service.rotateUserKey(userId, randomUUID(), async () => undefined),
      ]);
      await bothStarted.promise;
      release.resolve();
      const settled = await settling;
      expect(settled.filter((result) => result.status === 'fulfilled'))
        .toHaveLength(1);
      expect(await database.selectFrom('iam.user_internal_ssh_keys')
        .select('generation').where('user_id', '=', userId)
        .executeTakeFirstOrThrow()).toEqual({ generation: 2 });
      expect(audit.log).toHaveBeenCalledTimes(1);

      await database.updateTable('iam.users')
        .set({ status: UserStatus.Deleting })
        .where('id', '=', userId)
        .execute();
      await database.deleteFrom('iam.user_internal_ssh_keys')
        .where('user_id', '=', userId)
        .execute();
      await expect(service.rotateUserKey(
        userId,
        randomUUID(),
        async () => undefined,
      )).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'USER_DELETING' }),
      });
      expect(await database.selectFrom('iam.user_internal_ssh_keys')
        .select('user_id').execute()).toEqual([]);
    });
  });
});

function pair(label: string) {
  return {
    privateKey: `private-${label}`,
    publicKey: `public-${label}`,
    fingerprint: `fingerprint-${label}`,
  };
}

function fakeCrypto() {
  return {
    encrypt: (value: string) => `enc:${value}`,
    decrypt: (value: string) => value.replace(/^enc:/u, ''),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
