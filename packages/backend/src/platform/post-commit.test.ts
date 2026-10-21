import { describe, expect, it, vi } from 'vitest';
import { afterCommit, executeWithPostCommit, postCommitBestEffort } from './post-commit.js';

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

describe('afterCommit', () => {
  it('runs immediately outside a transaction', () => {
    const effect = vi.fn();
    afterCommit({ isTransaction: false }, effect);
    expect(effect).toHaveBeenCalledOnce();
  });

  it('defers effects until the transaction committed and drops them on rollback', async () => {
    const effect = vi.fn();
    const builder = (fail: boolean) => ({
      execute: async (work: (tx: { isTransaction: boolean }) => Promise<string>) => {
        const result = await work({ isTransaction: true });
        if (fail) throw new Error('commit failed');
        return result;
      },
    });

    await expect(executeWithPostCommit(builder(true) as never, async (tx) => {
      afterCommit(tx as never, effect);
      return 'x';
    })).rejects.toThrow('commit failed');
    expect(effect).not.toHaveBeenCalled();

    await executeWithPostCommit(builder(false) as never, async (tx) => {
      afterCommit(tx as never, effect);
      expect(effect).not.toHaveBeenCalled();
      return 'x';
    });
    expect(effect).toHaveBeenCalledOnce();
  });
});
