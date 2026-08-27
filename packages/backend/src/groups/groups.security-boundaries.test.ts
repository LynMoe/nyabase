import { describe, expect, it, vi } from 'vitest';
import { Capability } from '@nyabase/common';
import { ForbiddenException } from '@nestjs/common';
import { GroupsService } from './groups.service.js';

describe('GroupsService capability boundaries', () => {
  it('does not let a ManageGroups actor mutate a resource-bearing group grant', async () => {
    const access = {
      assertActorCapabilitiesInTransaction: vi.fn().mockRejectedValue(
        new ForbiddenException({
          code: 'PRIVILEGE_ESCALATION_DENIED',
        }),
      ),
    };
    const transactions = {
      run: vi.fn(async <T>(work: (transaction: unknown) => Promise<T>) => work({})),
    };
    const service = new GroupsService(
      undefined as never,
      transactions as never,
      access as never,
      undefined as never,
      undefined as never,
    );

    await expect(service.deleteGroupServerGrant(
      'group-a',
      'server-a',
      'actor-a',
    )).rejects.toMatchObject({
      response: { code: 'PRIVILEGE_ESCALATION_DENIED' },
    });
    expect(access.assertActorCapabilitiesInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'actor-a',
      [Capability.ManageGrants],
    );
  });
});
