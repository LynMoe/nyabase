import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  AuditAction,
  MAX_SSH_PUBLIC_KEYS_PER_USER,
  UserStatus,
} from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import {
  withPostgresTestDatabase,
  type PostgresTestDatabase,
} from '../../persistence-pg/postgres-test-harness.js';
import { usersPgFixture } from '../users.pg-test-helper.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;
const VALID_ED25519_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAFd/vaXN2I0jY5BiWgFdcK4lc66lU/wUQqmKHUgQzt3';

describePostgres('UsersService PostgreSQL SSH key durable hooks', () => {
  it('persists a normalized key and broadcasts redacted post-commit hooks', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, { seedActor: false });
      context.convergence.reconcileUser.mockRejectedValueOnce(new Error('queue unavailable'));
      const saved = await context.users.addSshKey(
        context.userId,
        'laptop',
        ` \t ${VALID_ED25519_KEY.replaceAll(' ', '\t  ')} \t `,
        context.userId,
      );
      expect(saved).toMatchObject({
        id: expect.any(String),
        userId: context.userId,
        keyText: VALID_ED25519_KEY,
      });
      expect(await fixture.database.selectFrom('iam.ssh_public_keys').selectAll()
        .where('id', '=', saved.id).executeTakeFirst())
        .toMatchObject({ user_id: context.userId, key_text: VALID_ED25519_KEY });
      expect(context.convergence.reconcileUser).not.toHaveBeenCalled();
      expect(context.proxySnapshots.notify).toHaveBeenCalledWith('user-ssh-key-added');
      expect(context.audit.log).toHaveBeenCalledWith(
        context.userId,
        AuditAction.AddUserSshPublicKey,
        saved.id,
        'ssh_public_key',
        expect.objectContaining({
          userId: context.userId,
          name: 'laptop',
          algorithm: 'ssh-ed25519',
          fingerprint: expect.stringMatching(/^SHA256:/),
        }),
      );
      const serialized = JSON.stringify(context.audit.log.mock.calls);
      expect(serialized).not.toContain('AAAAC3NzaC1lZDI1NTE5');
      expect(serialized).not.toContain('keyText');
    });
  });

  it('rejects invalid public key text before persistence or hooks', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, { seedActor: false });
      await expect(context.users.addSshKey(
        context.userId,
        'bogus',
        'not-an-ssh-public-key',
        context.userId,
      )).rejects.toBeInstanceOf(BadRequestException);
      expect(await fixture.database.selectFrom('iam.ssh_public_keys').select('id')
        .execute()).toEqual([]);
      expect(context.audit.log).not.toHaveBeenCalled();
      expect(context.proxySnapshots.notify).not.toHaveBeenCalled();
    });
  });

  it('rejects a fifth public key inside the admission transaction', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, { seedActor: false });
      await seedSshKeys(fixture, context.userId, MAX_SSH_PUBLIC_KEYS_PER_USER);
      await expect(context.users.addSshKey(
        context.userId,
        'overflow',
        VALID_ED25519_KEY,
        context.userId,
      )).rejects.toBeInstanceOf(ConflictException);
      expect(context.audit.log).not.toHaveBeenCalled();
    });
  });

  it('rejects additions for a non-active user in the same transaction', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, {
        seedActor: false,
        targetStatus: UserStatus.Deleting,
      });
      await expect(context.users.addSshKey(
        context.userId,
        'late-key',
        VALID_ED25519_KEY,
        context.userId,
      )).rejects.toBeInstanceOf(ConflictException);
      expect(context.audit.log).not.toHaveBeenCalled();
    });
  });

  it('deletes an owned key and broadcasts a redacted snapshot hook', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, { seedActor: false });
      const keyId = await seedSshKey(fixture, context.userId, 1);
      await expect(context.users.deleteSshKey(
        context.userId,
        keyId,
        context.userId,
      )).resolves.toBeUndefined();
      expect(await fixture.database.selectFrom('iam.ssh_public_keys').select('id')
        .where('id', '=', keyId).executeTakeFirst()).toBeUndefined();
      expect(context.convergence.reconcileUser).not.toHaveBeenCalled();
      expect(context.proxySnapshots.notify).toHaveBeenCalledWith('user-ssh-key-deleted');
      expect(context.audit.log).toHaveBeenCalledWith(
        context.userId,
        AuditAction.DeleteUserSshPublicKey,
        keyId,
        'ssh_public_key',
        expect.objectContaining({ userId: context.userId, name: 'laptop-1' }),
      );
      expect(JSON.stringify(context.audit.log.mock.calls)).not.toContain('key-material');
    });
  });

  it('does not run hooks when key deletion finds no owned key', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, { seedActor: false });
      await expect(context.users.deleteSshKey(
        context.userId,
        randomUUID(),
        context.userId,
      )).rejects.toBeInstanceOf(NotFoundException);
      expect(context.audit.log).not.toHaveBeenCalled();
      expect(context.proxySnapshots.notify).not.toHaveBeenCalled();
    });
  });

  it.each([UserStatus.Deleting, UserStatus.Deleted])(
    'fails closed when an administrator deletes a key for a %s target',
    async (status) => {
      await withPostgresTestDatabase(async (fixture) => {
        const context = await usersPgFixture(fixture, { targetStatus: status });
        const keyId = await seedSshKey(fixture, context.userId, 1);
        await expect(context.users.deleteSshKey(
          context.userId,
          keyId,
          context.actorId,
        )).rejects.toBeDefined();
        expect(await fixture.database.selectFrom('iam.ssh_public_keys').select('id')
          .where('id', '=', keyId).executeTakeFirst()).toBeTruthy();
        expect(context.audit.log).not.toHaveBeenCalled();
        expect(context.proxySnapshots.notify).not.toHaveBeenCalled();
      });
    },
  );

  it('rolls back the key and suppresses notification when atomic audit fails', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, { seedActor: false });
      context.audit.log.mockRejectedValueOnce(new Error('audit unavailable'));
      await expect(context.users.addSshKey(
        context.userId,
        'laptop',
        VALID_ED25519_KEY,
        context.userId,
      )).rejects.toThrow('audit unavailable');
      expect(await fixture.database.selectFrom('iam.ssh_public_keys').select('id')
        .where('user_id', '=', context.userId).execute()).toEqual([]);
      expect(context.proxySnapshots.notify).not.toHaveBeenCalled();
    });
  });

  it('does not audit or notify when persistence rejects a duplicate fingerprint', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, { seedActor: false });
      await context.users.addSshKey(
        context.userId,
        'first',
        VALID_ED25519_KEY,
        context.userId,
      );
      context.audit.log.mockClear();
      context.proxySnapshots.notify.mockClear();
      await expect(context.users.addSshKey(
        context.userId,
        'duplicate',
        VALID_ED25519_KEY,
        context.userId,
      )).rejects.toBeDefined();
      expect(context.audit.log).not.toHaveBeenCalled();
      expect(context.proxySnapshots.notify).not.toHaveBeenCalled();
    });
  });

  it('queues container convergence and proxy refresh when the internal key rotates', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, { seedActor: false });
      await context.users.notifyInternalSshKeyRotated(context.userId);
      expect(context.convergence.reconcileUser).toHaveBeenCalledWith(context.userId);
      expect(context.proxySnapshots.notify)
        .toHaveBeenCalledWith('user-internal-ssh-key-rotated');
    });
  });
});

async function seedSshKeys(
  fixture: PostgresTestDatabase,
  userId: string,
  count: number,
): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await seedSshKey(fixture, userId, index);
  }
}

async function seedSshKey(
  fixture: PostgresTestDatabase,
  userId: string,
  index: number,
): Promise<string> {
  const id = randomUUID();
  await fixture.database.insertInto('iam.ssh_public_keys').values({
    id,
    user_id: userId,
    name: `laptop-${index}`,
    key_text: `ssh-ed25519 key-material-${index}`,
    fingerprint: `SHA256:seed-${index}`,
    created_at: new Date(),
  }).execute();
  return id;
}
