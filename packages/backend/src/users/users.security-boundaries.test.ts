import { randomUUID } from 'node:crypto';
import { Capability } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { usersPgFixture } from './users.pg-test-helper.js';
import { pickNextUserNumericId } from './users.service.js';

describe('pickNextUserNumericId', () => {
  it('reuses holes below a reserved high system-actor id', () => {
    expect(pickNextUserNumericId([1, 2, 4096])).toBe(3);
  });

  it('returns null when every lifetime id is occupied', () => {
    const used = Array.from({ length: 4096 }, (_, index) => index + 1);
    expect(pickNextUserNumericId(used)).toBeNull();
  });
});

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('UsersService authorization boundaries', () => {
  it('denies administration when the actor lacks a target capability', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, {
        actorCapabilities: [Capability.ManageUsers, Capability.ManageGrants],
      });
      const privilegedGroup = randomUUID();
      await fixture.database.insertInto('iam.groups').values({
        id: privilegedGroup,
        name: `Privileged ${privilegedGroup.slice(0, 8)}`,
        description: null,
        priority: 1,
        is_system: false,
        system_key: null,
        capabilities: [Capability.ManageGroups],
        revision: 1,
      }).execute();
      await fixture.database.insertInto('iam.group_members').values({
        id: randomUUID(),
        group_id: privilegedGroup,
        user_id: context.userId,
      }).execute();

      await expect(context.users.updateUser(
        context.userId,
        { displayName: 'must-not-change' },
        context.actorId,
      )).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
      });
    });
  });

  it('rechecks ManageUsers after the actor membership is revoked', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);
      await fixture.database.deleteFrom('iam.group_members')
        .where('group_id', '=', context.actorGroupId)
        .where('user_id', '=', context.actorId)
        .execute();

      await expect(context.users.updateUser(
        context.userId,
        { displayName: 'must-not-change' },
        context.actorId,
      )).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
      });
    });
  });
});
