import { describe, expect, it, vi } from 'vitest';
import type { UserRecord } from '../domain/domain-records.js';
import type { MountSourcesService } from './mount-sources.service.js';
import { AdminMountSourcesController } from './admin-mount-sources.controller.js';

describe('AdminMountSourcesController request identities', () => {
  it.each([
    '../user-a',
    'user/a',
    `user-${'x'.repeat(129)}`,
  ])('rejects an invalid DELETE scopeId before touching grant state (%s)', async (scopeId) => {
    const deleteGrant = vi.fn();
    const controller = new AdminMountSourcesController({ deleteGrant } as unknown as MountSourcesService);

    await expect(controller.deleteGrant(
      'remote',
      'remote-a',
      'user',
      scopeId,
      undefined,
      { id: 'admin-a' } as UserRecord,
    )).rejects.toBeDefined();
    expect(deleteGrant).not.toHaveBeenCalled();
  });
});
