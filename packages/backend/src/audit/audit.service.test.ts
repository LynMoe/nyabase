import { describe, expect, it, vi } from 'vitest';
import { AuditAction } from '@nyabase/common';
import { AuditService } from './audit.service.js';

function makeHarness(options: {
  retentionDays?: number;
  maxEntries?: number;
  now?: number;
} = {}) {
  const transaction = { id: 'transaction' };
  const clock = vi.fn().mockReturnValue(options.now ?? 0);
  const repository = {
    append: vi.fn().mockResolvedValue(undefined),
    enforceRetention: vi.fn().mockResolvedValue(undefined),
    enforceRetentionInTransaction: vi.fn().mockResolvedValue(undefined),
  };
  const transactions = {
    run: vi.fn(async (work: (value: unknown) => Promise<unknown>) =>
      work(transaction)),
  };
  const config = {
    get: vi.fn((key: string) => {
      if (key === 'audit.retentionDays') return options.retentionDays ?? 180;
      if (key === 'audit.retentionMaxEntries') return options.maxEntries ?? 100_000;
      return undefined;
    }),
  };
  const snapshots = {
    resolve: vi.fn().mockResolvedValue(null),
  };
  const service = new AuditService(
    repository as never,
    transactions as never,
    config as never,
    snapshots as never,
    clock,
  );
  return {
    service,
    transaction,
    repository,
    transactions,
    clock,
  };
}

describe('AuditService retention paths', () => {
  it('enforces configured retention inside append transaction and sanitizes payloads', async () => {
    const harness = makeHarness();

    await harness.service.append(
      harness.transaction as never,
      null,
      AuditAction.CreateGroup,
      null,
      null,
      {
        password: 'do-not-store',
        nested: {
          apiToken: 'also-do-not-store',
          safe: 'keep',
        },
      },
    );

    expect(harness.repository.append).toHaveBeenCalledWith(
      harness.transaction,
      expect.objectContaining({
        payload: {
          password: '[REDACTED]',
          nested: {
            apiToken: '[REDACTED]',
            safe: 'keep',
          },
        },
      }),
    );
    expect(harness.repository.enforceRetentionInTransaction)
      .toHaveBeenCalledWith(harness.transaction, {
        retentionDays: 180,
        maxEntries: 100_000,
        enforceAge: true,
        enforceCount: true,
      });
    expect(harness.repository.enforceRetention).not.toHaveBeenCalled();
  });

  it('keeps log retention post-commit without recursively invoking append retention', async () => {
    const harness = makeHarness();

    await harness.service.log(
      null,
      AuditAction.CreateGroup,
      null,
      null,
      { authorization: 'do-not-store' },
    );

    expect(harness.transactions.run).toHaveBeenCalledOnce();
    expect(harness.repository.enforceRetention).toHaveBeenCalledWith({
      retentionDays: 180,
      maxEntries: 100_000,
      enforceAge: true,
      enforceCount: true,
    });
    expect(harness.repository.enforceRetentionInTransaction).not.toHaveBeenCalled();
    expect(harness.repository.append).toHaveBeenCalledWith(
      harness.transaction,
      expect.objectContaining({
        payload: { authorization: '[REDACTED]' },
      }),
    );
  });

  it('checks count and age on every caller-owned append transaction', async () => {
    const harness = makeHarness();
    harness.clock
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(30_000);

    await harness.service.append(
      harness.transaction as never,
      null,
      AuditAction.CreateGroup,
      null,
      null,
    );
    await harness.service.append(
      harness.transaction as never,
      null,
      AuditAction.CreateGroup,
      null,
      null,
    );

    expect(harness.repository.enforceRetentionInTransaction).toHaveBeenNthCalledWith(
      2,
      harness.transaction,
      {
        retentionDays: 180,
        maxEntries: 100_000,
        enforceAge: true,
        enforceCount: true,
      },
    );
  });

  it('does not start cleanup when both retention limits are disabled', async () => {
    const harness = makeHarness({ retentionDays: 0, maxEntries: 0 });

    await harness.service.append(
      harness.transaction as never,
      null,
      AuditAction.CreateGroup,
      null,
      null,
    );
    await harness.service.log(
      null,
      AuditAction.CreateGroup,
      null,
      null,
    );

    expect(harness.repository.enforceRetentionInTransaction).not.toHaveBeenCalled();
    expect(harness.repository.enforceRetention).not.toHaveBeenCalled();
  });
});
