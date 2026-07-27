import { describe, expect, it, vi } from 'vitest';
import {
  isRetryablePgTransactionError,
  retryPgTransaction,
} from './transaction.js';

describe('PostgreSQL transaction retries', () => {
  it('retries serialization failures and deadlocks only', async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('serialization'), { code: '40001' }))
      .mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: '40P01' }))
      .mockResolvedValue('committed');
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(retryPgTransaction(
      execute,
      { maxAttempts: 3, retryBaseDelayMs: 0 },
      sleep,
    )).resolves.toBe('committed');
    expect(execute).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry constraint violations', async () => {
    const error = Object.assign(new Error('duplicate'), { code: '23505' });
    const execute = vi.fn().mockRejectedValue(error);

    await expect(retryPgTransaction(
      execute,
      { maxAttempts: 3, retryBaseDelayMs: 0 },
    )).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(isRetryablePgTransactionError(error)).toBe(false);
  });

  it('recognizes a retryable SQLSTATE through wrapped causes', () => {
    const cause = Object.assign(new Error('deadlock'), { code: '40P01' });
    expect(isRetryablePgTransactionError(new Error('transaction failed', { cause })))
      .toBe(true);
  });

  it('reports bounded retry events for operational observability', async () => {
    const serializationFailure = Object.assign(new Error('serialization'), {
      code: '40001',
    });
    const execute = vi.fn()
      .mockRejectedValueOnce(serializationFailure)
      .mockResolvedValueOnce('committed');
    const onRetry = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(retryPgTransaction(
      execute,
      { maxAttempts: 3, retryBaseDelayMs: 0, onRetry },
      sleep,
    )).resolves.toBe('committed');
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      delayMs: 0,
      sqlstate: '40001',
    });
    expect(sleep).toHaveBeenCalledWith(0);
  });
});
