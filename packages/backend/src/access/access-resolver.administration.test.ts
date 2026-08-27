import { describe, expect, it, vi } from 'vitest';
import {
  Capability,
  SystemGroupKey,
  UserStatus,
} from '@nyabase/common';
import { AccessResolverService } from './access-resolver.service.js';

describe('AccessResolverService administration action projection', () => {
  it('projects per-user and per-group gates from canonical grants', async () => {
    const actorId = 'actor-1';
    const targetId = 'target-1';
    const administratorsGroupId = 'administrators-1';
    const now = new Date('2026-08-07T00:00:00.000Z');
    const users = [
      { id: actorId, status: UserStatus.Active },
      { id: targetId, status: UserStatus.Active },
    ];
    const groups = [{
      id: administratorsGroupId,
      name: 'Administrators',
      description: null,
      priority: 1000,
      is_system: true,
      system_key: SystemGroupKey.Administrators,
      capabilities: [
        Capability.ManageUsers,
        Capability.ManageGroups,
        Capability.ManageGrants,
      ],
      revision: 1,
      created_at: now,
      updated_at: now,
    }];
    const memberships = [
      { group_id: administratorsGroupId, user_id: targetId },
    ];
    const serverGrants = [
      { user_id: targetId, group_id: null },
      { user_id: null, group_id: administratorsGroupId },
    ];
    const query = (table: string) => {
      const builder = {
        select: vi.fn().mockReturnThis(),
        selectAll: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        forUpdate: vi.fn().mockReturnThis(),
        execute: vi.fn(async () => {
          if (table === 'iam.users') return users;
          if (table === 'iam.groups') return groups;
          if (table === 'iam.group_members') return memberships;
          if (table === 'iam.group_members as member') {
            return [{ capabilities: groups[0].capabilities }];
          }
          if (table === 'iam.server_grants') return serverGrants;
          return [];
        }),
        executeTakeFirst: vi.fn(async () => {
          if (table === 'iam.users') return users[0];
          return undefined;
        }),
        executeTakeFirstOrThrow: vi.fn(async () => ({ policy_epoch: 1 })),
      };
      return builder;
    };
    const transaction = {
      selectFrom: vi.fn((table: string) => query(table)),
    };
    const resolver = new AccessResolverService(
      undefined as never,
      { run: vi.fn((work: (tx: unknown) => unknown) => work(transaction)) } as never,
      undefined as never,
    );

    const actions = await resolver.administrationActionsCurrent(actorId);

    expect(Object.keys(actions.users)).toEqual([actorId, targetId]);
    expect(Object.keys(actions.groups)).toEqual([administratorsGroupId]);
    expect(actions.users[targetId]?.canDelete).toEqual({
      allowed: false,
      reason: '不能删除最后一个活跃管理员',
      missingCapabilities: [],
    });
    expect(actions.groups[administratorsGroupId]?.canRemoveMembers[targetId]).toEqual({
      allowed: false,
      reason: '不能移出最后一个活跃管理员',
      missingCapabilities: [],
    });
    expect(actions.groups[administratorsGroupId]?.canDelete).toEqual({
      allowed: false,
      reason: '内置用户组不可删除',
      missingCapabilities: [],
    });
  });
});
