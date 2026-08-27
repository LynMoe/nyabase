import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SystemGroupKey, UserStatus } from '@nyabase/common';
import {
  GroupsService,
  pickSystemActorNumericId,
  SYSTEM_ACTOR_DISPLAY_NAME,
  SYSTEM_ACTOR_PREFERRED_NUMERIC_ID,
  SYSTEM_ACTOR_USERNAME,
} from './groups.service.js';

describe('pickSystemActorNumericId', () => {
  it('prefers 4096 when free', () => {
    expect(pickSystemActorNumericId([1, 100, 1001, 3001])).toBe(
      SYSTEM_ACTOR_PREFERRED_NUMERIC_ID,
    );
  });

  it('picks the highest unused id that avoids common test numeric ids', () => {
    expect(pickSystemActorNumericId([4096, 1, 100, 1001, 3001])).toBe(4095);
    expect(pickSystemActorNumericId([4096, 4095, 3001])).toBe(4094);
  });
});

describe('GroupsService.ensureSystemGroups', () => {
  it('creates a login-disabled nyabase-system actor outside system groups', async () => {
    const iam = createIamState();
    const service = serviceWithIam(iam);

    await service.ensureSystemGroups();

    const actor = iam.users.find((user) => user.username === SYSTEM_ACTOR_USERNAME);
    expect(actor).toMatchObject({
      username: SYSTEM_ACTOR_USERNAME,
      display_name: SYSTEM_ACTOR_DISPLAY_NAME,
      status: UserStatus.Disabled,
      numeric_id: SYSTEM_ACTOR_PREFERRED_NUMERIC_ID,
    });
    expect(String(actor?.password_hash)).toMatch(/^\$argon2id\$/);
    expect(iam.members.some((member) => member.user_id === actor?.id)).toBe(false);
  });

  it('is idempotent and strips system-group membership if present', async () => {
    const iam = createIamState();
    const service = serviceWithIam(iam);
    await service.ensureSystemGroups();
    const actor = iam.users.find((user) => user.username === SYSTEM_ACTOR_USERNAME)!;
    const administrators = iam.groups.find(
      (group) => group.system_key === SystemGroupKey.Administrators,
    )!;
    iam.members.push({
      id: randomUUID(),
      group_id: administrators.id as string,
      user_id: actor.id as string,
    });

    await service.ensureSystemGroups();

    const after = iam.users.filter((user) => user.username === SYSTEM_ACTOR_USERNAME);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(actor.id);
    expect(after[0]?.status).toBe(UserStatus.Disabled);
    expect(iam.members.some((member) => member.user_id === actor.id)).toBe(false);
  });

  it('does not take numeric ids 1, 100, 1001, or 3001 when 4096 is occupied', async () => {
    const iam = createIamState();
    iam.users.push({
      id: randomUUID(),
      numeric_id: 4096,
      username: 'occupied-high',
      password_hash: 'hash',
      display_name: 'Occupied',
      status: UserStatus.Active,
    });
    const service = serviceWithIam(iam);

    await service.ensureSystemGroups();

    const actor = iam.users.find((user) => user.username === SYSTEM_ACTOR_USERNAME);
    expect(actor?.numeric_id).toBe(4095);
  });
});

function serviceWithIam(iam: IamState): GroupsService {
  const transactions = {
    run: vi.fn(async <T>(work: (transaction: unknown) => Promise<T>) =>
      work(createTransaction(iam))),
  };
  return new GroupsService(
    undefined as never,
    transactions as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
}

interface IamRow {
  id: string;
  [key: string]: unknown;
}

interface IamState {
  groups: IamRow[];
  users: IamRow[];
  members: IamRow[];
}

function createIamState(): IamState {
  return { groups: [], users: [], members: [] };
}

function createTransaction(iam: IamState) {
  return {
    insertInto(table: string) {
      return {
        values(row: IamRow) {
          return {
            onConflict() {
              return {
                execute: async () => {
                  insertRow(iam, table, row);
                },
                returningAll() {
                  return {
                    executeTakeFirst: async () => insertRow(iam, table, row),
                  };
                },
              };
            },
          };
        },
      };
    },
    selectFrom(table: string) {
      return createSelect(iam, table);
    },
    updateTable(table: string) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(key: string, _op: string, value: unknown) {
              return {
                execute: async () => {
                  const rows = tableRows(iam, table);
                  for (const row of rows) {
                    if (row[key] === value) Object.assign(row, values);
                  }
                },
              };
            },
          };
        },
      };
    },
    deleteFrom(table: string) {
      const filters: Array<{ key: string; op: string; value: unknown }> = [];
      const builder = {
        where(key: string, op: string, value: unknown) {
          filters.push({ key, op, value });
          return builder;
        },
        execute: async () => {
          if (table !== 'iam.group_members') return;
          iam.members = iam.members.filter((row) => !matches(row, filters));
        },
      };
      return builder;
    },
  };
}

function insertRow(iam: IamState, table: string, row: IamRow): IamRow | undefined {
  const now = new Date('2026-08-13T00:00:00.000Z');
  if (table === 'iam.policy_state') return undefined;
  if (table === 'iam.groups') {
    if (iam.groups.some((group) => group.system_key === row.system_key)) return undefined;
    const inserted = { created_at: now, updated_at: now, ...row };
    iam.groups.push(inserted);
    return inserted;
  }
  if (table === 'iam.users') {
    if (iam.users.some((user) => user.username === row.username)) return undefined;
    const inserted = { created_at: now, updated_at: now, ...row };
    iam.users.push(inserted);
    return inserted;
  }
  return undefined;
}

function createSelect(iam: IamState, table: string) {
  const filters: Array<{ key: string; op: string; value: unknown }> = [];
  const builder = {
    select() {
      return builder;
    },
    selectAll() {
      return builder;
    },
    where(key: string, op: string, value: unknown) {
      filters.push({ key, op, value });
      return builder;
    },
    execute: async () => tableRows(iam, table).filter((row) => matches(row, filters)),
    executeTakeFirst: async () => {
      const rows = tableRows(iam, table).filter((row) => matches(row, filters));
      return rows[0];
    },
    executeTakeFirstOrThrow: async () => {
      const row = tableRows(iam, table).filter((row) => matches(row, filters))[0];
      if (!row) throw new Error('no rows');
      return row;
    },
  };
  return builder;
}

function tableRows(iam: IamState, table: string): IamRow[] {
  if (table === 'iam.groups') return iam.groups;
  if (table === 'iam.users') return iam.users;
  if (table === 'iam.group_members') return iam.members;
  return [];
}

function matches(
  row: IamRow,
  filters: Array<{ key: string; op: string; value: unknown }>,
): boolean {
  return filters.every((filter) => {
    const actual = row[filter.key];
    if (filter.op === 'in' && Array.isArray(filter.value)) {
      return filter.value.includes(actual);
    }
    return actual === filter.value;
  });
}
