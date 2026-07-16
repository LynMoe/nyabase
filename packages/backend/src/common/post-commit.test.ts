import { describe, expect, it, vi } from 'vitest';
import { postCommitBestEffort } from './post-commit.js';

describe('postCommitBestEffort', () => {
  it('never changes a committed caller outcome when an observer rejects', async () => {
    const logger = { warn: vi.fn() };
    await expect(postCommitBestEffort(
      'snapshot',
      () => Promise.reject(new Error('transport failed')),
      logger,
    )).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('transport failed'));
  });
});
