import { Role, UserStatus } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { seedUser } from '../iam/access.pg-test-helper.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { usersPgFixture } from './users.pg-test-helper.js';
import { pickNextUserNumericId } from './users.service.js';

describe('pickNextUserNumericId', () => {
  it('reuses the lowest hole below the highest used id', () => {
    expect(pickNextUserNumericId([1, 2, 4096])).toBe(3);
  });

  it('returns null when every lifetime id is occupied', () => {
    const used = Array.from({ length: 4096 }, (_, index) => index + 1);
    expect(pickNextUserNumericId(used)).toBeNull();
  });
});

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('UsersService authorization boundaries', () => {
  it('denies administration to an actor below user admin', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      for (const role of [Role.User]) {
        const context = await usersPgFixture(fixture, { actorRole: role });
        await expect(context.users.updateUser(
          context.userId,
          { displayName: 'must-not-change' },
          context.actorId,
        )).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ROLE_REQUIRED' }) });
        await expect(context.users.createUser(
          { username: 'newcomer', password: 'password-1', displayName: 'New' },
          { actorId: context.actorId },
        )).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ROLE_REQUIRED' }) });
        await fixture.database.deleteFrom('iam.users').execute();
      }
    });
  });

  it('lets a user admin administer users and user admins, but not admins or roles', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, { actorRole: Role.UserAdmin });
      const peer = await seedUser(fixture.database, undefined, UserStatus.Active, Role.UserAdmin);
      const admin = await seedUser(fixture.database, undefined, UserStatus.Active, Role.Admin);

      await expect(context.users.updateUser(context.userId, { displayName: 'Renamed' }, context.actorId))
        .resolves.toMatchObject({ displayName: 'Renamed' });
      await expect(context.users.updateUser(peer, { status: UserStatus.Disabled }, context.actorId))
        .resolves.toMatchObject({ status: UserStatus.Disabled });
      await expect(context.users.updateUser(admin, { password: 'password-2' }, context.actorId))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: 'ADMINISTRATOR_PROTECTED' }) });
      await expect(context.users.updateUser(admin, { status: UserStatus.Disabled }, context.actorId))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: 'ADMINISTRATOR_PROTECTED' }) });
      await expect(context.users.updateUser(context.userId, { role: Role.UserAdmin }, context.actorId))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: 'ROLE_REQUIRED' }) });

      const created = await context.users.createUser(
        { username: 'by-user-admin', password: 'password-1', displayName: 'New' },
        { actorId: context.actorId },
      );
      expect(created.role).toBe(Role.User);
      await expect(context.users.createUser(
        { username: 'elevated', password: 'password-1', displayName: 'New', role: Role.UserAdmin },
        { actorId: context.actorId },
      )).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ROLE_REQUIRED' }) });
    });
  });

  it('rechecks the admin role after the actor was demoted', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);
      await fixture.database.updateTable('iam.users')
        .set({ role: Role.User })
        .where('id', '=', context.actorId)
        .execute();

      await expect(context.users.updateUser(
        context.userId,
        { displayName: 'must-not-change' },
        context.actorId,
      )).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ROLE_REQUIRED' }) });
    });
  });

  it('rechecks the admin role of a disabled actor', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);
      await fixture.database.updateTable('iam.users')
        .set({ status: UserStatus.Disabled })
        .where('id', '=', context.actorId)
        .execute();

      await expect(context.users.updateUser(
        context.userId,
        { displayName: 'must-not-change' },
        context.actorId,
      )).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ROLE_REQUIRED' }) });
    });
  });

  it('creates users with the requested role, user by default, and audits it', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);

      const plain = await context.users.createUser(
        { username: 'plain-user', password: 'password-1', displayName: 'Plain' },
        { actorId: context.actorId },
      );
      const userAdmin = await context.users.createUser(
        { username: 'new-user-admin', password: 'password-1', displayName: 'User admin', role: Role.UserAdmin },
        { actorId: context.actorId },
      );

      expect(plain.role).toBe(Role.User);
      expect(userAdmin.role).toBe(Role.UserAdmin);
      expect(context.audit.append).toHaveBeenCalledWith(
        expect.anything(), context.actorId, 'user.create', userAdmin.id, 'user',
        expect.objectContaining({ role: Role.UserAdmin }),
      );
    });
  });
});

describePg('UsersService role changes and the last-administrator guard', () => {
  it('changes a role through updateUser, takes effect without bumping the session, and audits it', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);
      const before = await fixture.database.selectFrom('iam.users')
        .select('auth_version').where('id', '=', context.userId).executeTakeFirstOrThrow();

      const updated = await context.users.updateUser(
        context.userId, { role: Role.UserAdmin }, context.actorId,
      );

      expect(updated.role).toBe(Role.UserAdmin);
      const row = await fixture.database.selectFrom('iam.users')
        .select(['role', 'auth_version']).where('id', '=', context.userId).executeTakeFirstOrThrow();
      expect(row).toEqual({ role: Role.UserAdmin, auth_version: before.auth_version });
      expect(context.audit.append).toHaveBeenCalledWith(
        expect.anything(), context.actorId, 'user.role_changed', context.userId, 'user',
        { from: Role.User, to: Role.UserAdmin },
      );
      expect(await context.users.toDto(updated)).toMatchObject({ role: Role.UserAdmin });
    });
  });

  it('does not audit a role change when the role stays the same', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);
      await context.users.updateUser(context.userId, { role: Role.User }, context.actorId);
      expect(context.audit.append).not.toHaveBeenCalledWith(
        expect.anything(), expect.anything(), 'user.role_changed', expect.anything(), 'user', expect.anything(),
      );
    });
  });

  it('refuses to demote the last active administrator, but not once another one exists', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);
      await seedUser(fixture.database, undefined, UserStatus.Disabled, Role.Admin);

      await expect(context.users.updateUser(context.actorId, { role: Role.UserAdmin }, context.actorId))
        .rejects.toMatchObject({ response: { code: 'LAST_ACTIVE_ADMINISTRATOR' } });

      await context.users.updateUser(context.userId, { role: Role.Admin }, context.actorId);
      await expect(context.users.updateUser(context.actorId, { role: Role.UserAdmin }, context.actorId))
        .resolves.toMatchObject({ role: Role.UserAdmin });
    });
  });

  it('refuses to disable the last active administrator', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);

      await expect(context.users.updateUser(
        context.actorId, { status: UserStatus.Disabled }, context.actorId,
      )).rejects.toMatchObject({ response: { code: 'LAST_ACTIVE_ADMINISTRATOR' } });

      await context.users.updateUser(context.userId, { role: Role.Admin }, context.actorId);
      await expect(context.users.updateUser(
        context.userId, { status: UserStatus.Disabled }, context.actorId,
      )).resolves.toMatchObject({ status: UserStatus.Disabled });
    });
  });

  it('allows disabling and demoting users who are not active administrators', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);
      await expect(context.users.updateUser(
        context.userId, { status: UserStatus.Disabled }, context.actorId,
      )).resolves.toMatchObject({ status: UserStatus.Disabled });
      await expect(context.users.updateUser(
        context.userId, { role: Role.UserAdmin }, context.actorId,
      )).resolves.toMatchObject({ role: Role.UserAdmin });
    });
  });
});
