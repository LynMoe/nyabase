import { randomUUID } from 'node:crypto';
import { Role, UserStatus } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { seedUser } from './access.pg-test-helper.js';
import { IamAuthRepository } from './iam-auth.repository.js';

const hex = (digit: string): string => digit.repeat(64);
const TOKEN_HASH = hex('a');

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('IamAuthRepository role loading', () => {
  it('carries the current role on every authentication path', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const repository = new IamAuthRepository(database, new PgTransactionManager(database));
      const userId = await seedUser(database, 'role-user', UserStatus.Active, Role.Operator);

      // JWT path: the guard resolves the user by id on every request.
      await expect(repository.findUserById(userId)).resolves.toMatchObject({ role: Role.Operator });
      await expect(repository.findUserByUsername('role-user')).resolves.toMatchObject({ role: Role.Operator });

      // API-token path.
      await database.insertInto('iam.api_tokens').values({
        id: randomUUID(), user_id: userId, name: 'ci', hash: TOKEN_HASH,
      }).execute();
      const viaToken = await repository.validateApiToken(TOKEN_HASH, new Date(), 60_000);
      expect(viaToken).toMatchObject({ id: userId, role: Role.Operator });

      // Refresh rotation returns the user row too.
      await repository.issueRefreshSession(userId, { id: randomUUID(), hash: hex('1'), expiresInMs: 60_000 }, 5);
      const rotated = await repository.rotateRefreshSession({
        hash: hex('1'),
        requestIdHash: hex('3'),
        expiresInMs: 60_000,
        maximumSessions: 5,
        successorHash: () => hex('2'),
      });
      expect(rotated).toMatchObject({ kind: 'rotated', user: { role: Role.Operator } });

      // A role change is visible on the very next read: no auth_version bump needed.
      await database.updateTable('iam.users').set({ role: Role.Admin }).where('id', '=', userId).execute();
      await expect(repository.findUserById(userId)).resolves.toMatchObject({ role: Role.Admin, authVersion: 0 });
      await expect(repository.validateApiToken(TOKEN_HASH, new Date(), 60_000))
        .resolves.toMatchObject({ role: Role.Admin });
    });
  });
});
