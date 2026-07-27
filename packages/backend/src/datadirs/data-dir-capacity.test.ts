import { MAX_MANAGED_DATA_DIRS_PER_AGENT } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { assertAgentDataDirCapacity } from './data-dir-capacity.js';

describe('Agent DataDir projection capacity', () => {
  it('locks and checks the complete projected server view', async () => {
    const lockDataDirectoryCapacity = vi.fn().mockResolvedValue(undefined);
    const countDataDirectoryProjection = vi.fn().mockResolvedValue(3);
    const storage = {
      lockDataDirectoryCapacity,
      countDataDirectoryProjection,
    };
    const transaction = {};
    await expect(assertAgentDataDirCapacity(
      storage as never,
      transaction as never,
      'server-a',
      {
        includeRemoteMountId: 'remote-b',
        additionalRows: MAX_MANAGED_DATA_DIRS_PER_AGENT - 3,
      },
    )).resolves.toBeUndefined();
    await expect(assertAgentDataDirCapacity(
      storage as never,
      transaction as never,
      'server-a',
      {
        includeRemoteMountId: 'remote-b',
        additionalRows: MAX_MANAGED_DATA_DIRS_PER_AGENT - 2,
      },
    )).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DATA_DIRECTORY_CAPACITY_REACHED' }),
    });
    expect(lockDataDirectoryCapacity).toHaveBeenCalledWith(
      'server-a',
      transaction,
    );
    expect(countDataDirectoryProjection).toHaveBeenCalledWith(
      'server-a',
      'remote-b',
      transaction,
    );
  });
});
