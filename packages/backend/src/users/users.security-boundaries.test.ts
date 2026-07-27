import { randomUUID } from 'node:crypto';
import { AuditAction, Capability, SystemGroupKey } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import {
  withPostgresTestDatabase,
  type PostgresTestDatabase,
} from '../persistence-pg/postgres-test-harness.js';
import { InfrastructureRepository } from '../infrastructure/infrastructure.repository.js';
import { usersPgFixture } from './users.pg-test-helper.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describePostgres('UsersService PostgreSQL security mutation boundaries', () => {
  it('allows ManageUsers to reset an ordinary user and redacts the password from audit', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);
      await expect(context.users.updateUser(
        context.userId,
        { password: 'new-pass-123' },
        context.actorId,
      )).resolves.toMatchObject({ passwordHash: 'hash:new-pass-123', authVersion: 1 });
      expect(context.auth.revokeBrowserSessionsInTransaction).toHaveBeenCalledOnce();
      expect(context.audit.log).toHaveBeenCalledWith(
        context.actorId,
        AuditAction.UpdateUser,
        context.userId,
        'user',
        expect.objectContaining({ passwordChanged: true }),
      );
      expect(JSON.stringify(context.audit.log.mock.calls)).not.toContain('new-pass-123');
    });
  });

  it('requires ManageGrants for privileged mutations of a granted user', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);
      const serverId = randomUUID();
      await new InfrastructureRepository(fixture.database).insertServer({
        id: serverId,
        name: 'Users Security Node',
        slug: `users-${serverId.slice(0, 8)}`,
        agentTokenHash: 'e'.repeat(64),
      });
      await fixture.database.insertInto('iam.server_grants').values({
        id: randomUUID(),
        user_id: context.userId,
        group_id: null,
        server_id: serverId,
        cpu_millis: 1000,
        mem_bytes: 1024,
        disk_bytes: 4096,
        gpu_mode: 'none',
        gpu_indices: null,
      }).execute();
      const grantVersions = await fixture.database.selectFrom('iam.users')
        .select(['auth_version', 'authz_version'])
        .where('id', '=', context.userId)
        .executeTakeFirstOrThrow();
      expect(grantVersions.auth_version).toBe(0);
      expect(Number(grantVersions.authz_version)).toBe(1);
      const keyId = await insertSshKey(fixture.database, context.userId);
      await expect(context.users.updateUser(
        context.userId,
        { password: 'new-pass-123' },
        context.actorId,
      )).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
      });
      await expect(context.users.deleteSshKey(context.userId, keyId, context.actorId))
        .rejects.toMatchObject({
          response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
        });
      await expect(context.users.getInternalSshKey(context.actorId, context.userId, true))
        .rejects.toMatchObject({
          response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
        });
      await fixture.database.updateTable('iam.groups')
        .set({ capabilities: [Capability.ManageUsers, Capability.ManageGrants] })
        .where('id', '=', context.actorGroupId)
        .executeTakeFirstOrThrow();
      await expect(context.users.updateUser(
        context.userId,
        { password: 'new-pass-123' },
        context.actorId,
      )).resolves.toMatchObject({ authVersion: 1 });
      context.audit.log.mockClear();
      await expect(context.users.deleteSshKey(context.userId, keyId, context.actorId))
        .resolves.toBeUndefined();
      expect(context.audit.log).toHaveBeenCalledWith(
        context.actorId,
        AuditAction.DeleteUserSshPublicKey,
        keyId,
        'ssh_public_key',
        expect.objectContaining({ userId: context.userId, name: 'laptop' }),
      );
      expect(JSON.stringify(context.audit.log.mock.calls)).not.toContain('AAAAC3');
    });
  });

  it('denies an actor who lacks a capability held by the target', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, {
        actorCapabilities: [Capability.ManageUsers, Capability.ManageGrants],
      });
      const privileged = randomUUID();
      await fixture.database.insertInto('iam.groups').values({
        id: privileged,
        name: `Privileged ${privileged.slice(0, 8)}`,
        description: null,
        priority: 1,
        is_system: false,
        system_key: null,
        capabilities: [Capability.ManageGroups],
        revision: 1,
      }).execute();
      await fixture.database.insertInto('iam.group_members').values({
        id: randomUUID(), group_id: privileged, user_id: context.userId,
      }).execute();
      await expect(context.users.updateUser(
        context.userId,
        { password: 'new-pass-123' },
        context.actorId,
      )).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
      });
    });
  });

  it('rechecks ManageUsers after a controller guard could have passed', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);
      await fixture.database.deleteFrom('iam.group_members')
        .where('group_id', '=', context.actorGroupId)
        .where('user_id', '=', context.actorId)
        .execute();
      await expect(context.users.updateUser(
        context.userId,
        { displayName: 'stolen' },
        context.actorId,
      )).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
      });
      expect(await fixture.database.selectFrom('iam.users').select('display_name')
        .where('id', '=', context.userId).executeTakeFirstOrThrow())
        .toMatchObject({ display_name: 'target' });
    });
  });

  it('makes concurrent self password changes a one-winner CAS and audits only the winner', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);
      let verificationCount = 0;
      const verified = deferred();
      context.auth.verifyPassword.mockImplementation(async () => {
        verificationCount += 1;
        if (verificationCount === 2) verified.resolve();
        await verified.promise;
        return true;
      });
      const results = await Promise.allSettled([
        context.users.updateSelf(
          context.userId,
          { displayName: 'first', password: 'first-pass' },
          'old-pass',
        ),
        context.users.updateSelf(
          context.userId,
          { displayName: 'second', password: 'second-pass' },
          'old-pass',
        ),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const target = await fixture.database.selectFrom('iam.users')
        .select(['password_hash', 'auth_version'])
        .where('id', '=', context.userId)
        .executeTakeFirstOrThrow();
      expect(['hash:first-pass', 'hash:second-pass']).toContain(target.password_hash);
      expect(target.auth_version).toBe(1);
      expect(context.audit.log).toHaveBeenCalledTimes(1);
    });
  });

  it('creates user, built-in membership and internal identity atomically', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);
      const usersGroup = randomUUID();
      await fixture.database.insertInto('iam.groups').values({
        id: usersGroup,
        name: 'Users',
        description: null,
        priority: 1,
        is_system: true,
        system_key: SystemGroupKey.Users,
        capabilities: [],
        revision: 1,
      }).execute();
      const created = await context.users.createUser({
        username: 'new-user',
        password: 'new-user-pass',
        displayName: 'New User',
      }, { systemGroupKey: SystemGroupKey.Users, actorId: context.actorId });
      expect(await fixture.database.selectFrom('iam.group_members').select('id')
        .where('group_id', '=', usersGroup).where('user_id', '=', created.id)
        .executeTakeFirst()).toBeTruthy();
      expect(await fixture.database.selectFrom('iam.user_internal_ssh_keys').selectAll()
        .where('user_id', '=', created.id).executeTakeFirst())
        .toMatchObject({ generation: 1, public_key: expect.stringContaining('ssh-ed25519') });
      expect(JSON.stringify(context.audit.log.mock.calls)).not.toContain('new-user-pass');

      await expect(context.users.createUser({
        username: 'orphan',
        password: 'orphan-pass',
        displayName: 'Orphan',
      }, { systemGroupKey: SystemGroupKey.Operators, actorId: context.actorId }))
        .rejects.toMatchObject({
          response: expect.objectContaining({ code: 'SYSTEM_GROUP_MISSING' }),
        });
      expect(await fixture.database.selectFrom('iam.users').select('id')
        .where('username', '=', 'orphan').executeTakeFirst()).toBeUndefined();
    });
  });

  it('generates keys outside the transaction and rechecks revoked authority before save', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);
      const started = deferred();
      const release = deferred();
      context.prepareUserKey.mockImplementationOnce(async (user: { id: string }) => {
        started.resolve();
        await release.promise;
        return {
          userId: user.id,
          encryptedPrivateKey: 'enc:revoked',
          publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest revoked',
          fingerprint: 'SHA256:revoked',
          generation: 1,
          rotatedAt: new Date(),
        };
      });
      const creation = context.users.createUser({
        username: 'revoked-create',
        password: 'new-user-pass',
        displayName: 'Revoked Create',
      }, { actorId: context.actorId });
      await started.promise;
      await fixture.database.deleteFrom('iam.group_members')
        .where('group_id', '=', context.actorGroupId)
        .where('user_id', '=', context.actorId)
        .execute();
      release.resolve();
      await expect(creation).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
      });
      expect(await fixture.database.selectFrom('iam.users').select('id')
        .where('username', '=', 'revoked-create').executeTakeFirst()).toBeUndefined();
      expect(context.savePreparedUserKeyInTransaction).not.toHaveBeenCalled();
    });
  });

  it('does not partially create a user when external key generation fails', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);
      context.prepareUserKey.mockRejectedValueOnce(new Error('ssh-keygen unavailable'));
      await expect(context.users.createUser({
        username: 'keygen-failed',
        password: 'new-user-pass',
        displayName: 'Keygen Failed',
      }, { actorId: context.actorId })).rejects.toThrow('ssh-keygen unavailable');
      expect(await fixture.database.selectFrom('iam.users').select('id')
        .where('username', '=', 'keygen-failed').executeTakeFirst()).toBeUndefined();
      expect(context.audit.log).not.toHaveBeenCalled();
    });
  });
});

async function insertSshKey(
  database: PostgresTestDatabase['database'],
  userId: string,
): Promise<string> {
  const id = randomUUID();
  await database.insertInto('iam.ssh_public_keys').values({
    id,
    user_id: userId,
    name: 'laptop',
    key_text: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest',
    fingerprint: 'SHA256:test',
    created_at: new Date(),
  }).execute();
  return id;
}
