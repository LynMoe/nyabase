import { AgentTaskKind } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import type { XfsQuotaManager } from '../../quota/xfs-quota.js';
import { IncompleteTaskError, ManagedTaskError } from '../task-handler.js';
import { QuotaTaskHandler } from './quota-task.handler.js';

describe('QuotaTaskHandler convergence', () => {
  it('reapplies and verifies the same normalized hard limit safely', async () => {
    const quota = {
      setLimit: vi.fn().mockResolvedValue(undefined),
      getUsageForUser: vi.fn().mockResolvedValue({
        numericUserId: 7,
        projectId: 10007,
        usedBytes: 0,
        hardLimitBytes: 2048,
      }),
    };
    const handler = new QuotaTaskHandler(quota as unknown as XfsQuotaManager);
    const payload = { generation: 1, numericUserId: 7, diskBytes: 1025 };

    const first = await handler.ensure(AgentTaskKind.QuotaEnsure, payload);
    await handler.verify(AgentTaskKind.QuotaEnsure, payload, first);
    const second = await handler.ensure(AgentTaskKind.QuotaEnsure, payload);
    await handler.verify(AgentTaskKind.QuotaEnsure, payload, second);

    expect(first).toEqual({ numericUserId: 7, hardLimitBytes: 2048 });
    expect(second).toEqual(first);
    expect(quota.setLimit).toHaveBeenCalledTimes(2);
    expect(quota.getUsageForUser).toHaveBeenCalledTimes(2);
  });

  it('accepts an observed effective-zero limit after an idempotent clear error', async () => {
    const quota = {
      setLimit: vi.fn().mockRejectedValue(new Error('clear raced with an earlier clear')),
      getUsageForUser: vi.fn().mockResolvedValue({
        numericUserId: 7,
        projectId: 10007,
        usedBytes: 0,
        hardLimitBytes: 0,
      }),
    };
    const handler = new QuotaTaskHandler(quota as unknown as XfsQuotaManager);
    const payload = { generation: 2, numericUserId: 7, diskBytes: 0 };

    const result = await handler.ensure(AgentTaskKind.QuotaEnsure, payload);
    await expect(handler.verify(AgentTaskKind.QuotaEnsure, payload, result)).resolves.toBeUndefined();
    expect(result).toEqual({ numericUserId: 7, hardLimitBytes: 0 });
  });

  it('returns a terminal failure when a fresh observation proves no limit', async () => {
    const quota = {
      setLimit: vi.fn().mockRejectedValue(new Error('second XFS source failed')),
      getUsageForUser: vi.fn().mockResolvedValue(null),
    };
    const handler = new QuotaTaskHandler(quota as unknown as XfsQuotaManager);

    await expect(handler.ensure(AgentTaskKind.QuotaEnsure, {
      generation: 1,
      numericUserId: 7,
      diskBytes: 1025,
    })).rejects.toMatchObject({
      name: ManagedTaskError.name,
      taskError: { code: 'quota_apply_failed' },
      observed: { numericUserId: 7, present: false },
    });
  });

  it('returns a terminal failure when verification observes a different hard limit', async () => {
    const quota = {
      setLimit: vi.fn().mockResolvedValue(undefined),
      getUsageForUser: vi.fn().mockResolvedValue({
        numericUserId: 7,
        projectId: 10007,
        usedBytes: 0,
        hardLimitBytes: 1024,
      }),
    };
    const handler = new QuotaTaskHandler(quota as unknown as XfsQuotaManager);

    await expect(handler.verify(AgentTaskKind.QuotaEnsure, {
      generation: 1,
      numericUserId: 7,
      diskBytes: 1025,
    }, { numericUserId: 7, hardLimitBytes: 2048 })).rejects.toMatchObject({
      name: ManagedTaskError.name,
      taskError: { code: 'quota_not_converged' },
      observed: { numericUserId: 7, hardLimitBytes: 1024 },
    });
  });

  it('stays pending only when the quota observation itself is unavailable', async () => {
    const quota = {
      setLimit: vi.fn().mockRejectedValue(new Error('apply failed')),
      getUsageForUser: vi.fn().mockRejectedValue(new Error('report unavailable')),
    };
    const handler = new QuotaTaskHandler(quota as unknown as XfsQuotaManager);
    await expect(handler.ensure(AgentTaskKind.QuotaEnsure, {
      generation: 1, numericUserId: 7, diskBytes: 1025,
    })).rejects.toMatchObject({
      name: IncompleteTaskError.name,
      taskError: { code: 'quota_observation_unavailable' },
    });
  });
});
