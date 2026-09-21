import { IntentResourceType } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { IntentRepository } from './intent.repository.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('IntentRepository empty resourceIds (PostgreSQL)', () => {
  it('does not compile IN () for list or listPending', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const repository = new IntentRepository(database);
      await expect(repository.list({
        resourceType: IntentResourceType.ImageAssignment,
        resourceIds: [],
      })).resolves.toEqual({ items: [], nextCursor: null });
      await expect(repository.listPending({
        resourceIds: [],
      })).resolves.toEqual({ items: [], nextCursor: null });
    });
  });
});
