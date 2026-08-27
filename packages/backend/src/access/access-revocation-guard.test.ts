import { ConflictException } from '@nestjs/common';
import type { Transaction } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { AccessRevocationGuardService } from './access-revocation-guard.service.js';

type Row = Record<string, unknown>;

describe('AccessRevocationGuardService', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const serverId = '22222222-2222-4222-8222-222222222222';
  const poolId = '33333333-3333-4333-8333-333333333333';
  const sharedBackendId = '44444444-4444-4444-8444-444444444444';

  it('blocks local server dependencies but ignores shared-volume dependencies', async () => {
    const guard = new AccessRevocationGuardService();
    const local = {
      dependency_kind: 'volume',
      dependency_id: 'local-volume',
      user_id: userId,
      server_id: serverId,
      pool_id: poolId,
      shared_backend_id: null,
    };
    const shared = {
      dependency_kind: 'volume',
      dependency_id: 'shared-volume',
      user_id: userId,
      server_id: null,
      pool_id: null,
      shared_backend_id: sharedBackendId,
    };

    await expect(guard.assertServerAccessRevocationSafe(
      fakeTransaction({
        'control.authorization_dependencies': [local, shared],
      }),
      [{ userId, serverId }],
    )).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'GRANT_REVOCATION_BLOCKED',
        dependencyId: 'local-volume',
      }),
    });

    await expect(guard.assertServerAccessRevocationSafe(
      fakeTransaction({
        'control.authorization_dependencies': [shared],
      }),
      [{ userId, serverId }],
    )).resolves.toBeUndefined();
  });

  it('matches pool and shared-backend revocation to their own volume scope', async () => {
    const guard = new AccessRevocationGuardService();
    const local = {
      dependency_kind: 'volume',
      dependency_id: 'local-volume',
      user_id: userId,
      server_id: serverId,
      pool_id: poolId,
      shared_backend_id: null,
    };
    const shared = {
      dependency_kind: 'volume',
      dependency_id: 'shared-volume',
      user_id: userId,
      server_id: null,
      pool_id: null,
      shared_backend_id: sharedBackendId,
    };

    await expect(guard.assertStoragePoolAccessRevocationSafe(
      fakeTransaction({
        'control.authorization_dependencies': [local, shared],
      }),
      [{ userId, poolId }],
    )).rejects.toBeInstanceOf(ConflictException);

    await expect(guard.assertSharedBackendAccessRevocationSafe(
      fakeTransaction({
        'control.authorization_dependencies': [local, shared],
      }),
      [{ userId, sharedBackendId }],
    )).rejects.toMatchObject({
      response: expect.objectContaining({ dependencyId: 'shared-volume' }),
    });
  });

  it('does not block a revoke when another non-lost grant still covers access', async () => {
    const guard = new AccessRevocationGuardService();
    await expect(guard.assertServerAccessRevocationSafe(
      fakeTransaction({
        'iam.server_grants': [{
          id: 'remaining-grant',
          server_id: serverId,
          user_id: userId,
          expires_at: null,
        }],
        'control.authorization_dependencies': [{
          dependency_kind: 'container',
          dependency_id: 'container',
          user_id: userId,
          server_id: serverId,
          pool_id: null,
          shared_backend_id: null,
        }],
      }),
      [{ userId, serverId }],
    )).resolves.toBeUndefined();
  });
});

function fakeTransaction(rowsByTable: Record<string, Row[]>): Transaction<NyabaseDatabase> {
  return {
    selectFrom(table: string) {
      const predicates: Array<[string, string, unknown]> = [];
      const rows = rowsByTable[table] ?? [];
      const query = {
        select: () => query,
        where: (
          columnOrCallback: string | ((expression: unknown) => unknown),
          operator?: string,
          value?: unknown,
        ) => {
          if (typeof columnOrCallback === 'string' && operator) {
            predicates.push([columnOrCallback, operator, value]);
          }
          return query;
        },
        orderBy: () => query,
        execute: async () => filterRows(rows, predicates),
        executeTakeFirst: async () => filterRows(rows, predicates)[0],
      };
      return query;
    },
  } as unknown as Transaction<NyabaseDatabase>;
}

function filterRows(rows: Row[], predicates: Array<[string, string, unknown]>): Row[] {
  return rows.filter((row) => predicates.every(([column, operator, value]) => {
    if (operator === '=') return row[column] === value;
    if (operator === 'is') return value === null ? row[column] === null : row[column] === value;
    if (operator === 'in' && Array.isArray(value)) return value.includes(row[column]);
    return true;
  }));
}
