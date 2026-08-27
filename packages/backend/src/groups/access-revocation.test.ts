import { ForbiddenException } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { GroupsService } from './groups.service.js';

describe('GroupsService grant mutation authorization', () => {
  it('checks ManageGrants before a direct server-grant delete', async () => {
    const access = {
      assertActorCapabilitiesInTransaction: vi.fn().mockRejectedValue(
        new ForbiddenException({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
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

    await expect(service.deleteUserServerGrant(
      'user-a',
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

  it('uses the same capability boundary for pool and backend grant deletes', async () => {
    const access = {
      assertActorCapabilitiesInTransaction: vi.fn().mockRejectedValue(
        new ForbiddenException({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
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

    await expect(service.deleteUserStoragePoolGrant(
      'user-a',
      'pool-a',
      'actor-a',
    )).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.deleteUserSharedBackendGrant(
      'user-a',
      'backend-a',
      'actor-a',
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.assertActorCapabilitiesInTransaction).toHaveBeenCalledTimes(2);
  });
});
