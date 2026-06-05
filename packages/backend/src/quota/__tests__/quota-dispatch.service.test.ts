import { HookKind } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { QuotaDispatchService, type QuotaApplyRequest } from '../quota-dispatch.service.js';

function makeRequest(overrides: Partial<QuotaApplyRequest> = {}): QuotaApplyRequest {
  return {
    serverId: 'server-a',
    userId: 'user-a',
    numericUserId: 1001,
    diskBytes: 4096,
    requestedBy: 'actor-a',
    ...overrides,
  };
}

function makeService(existing: unknown = null) {
  const quotaDesiredRepo = {
    findOne: vi.fn().mockResolvedValue(existing),
    create: vi.fn((input) => input),
    save: vi.fn(async (input) => ({ ...input, id: input.id ?? 'quota-a' })),
  };
  const lifecycleHooks = {
    enqueue: vi.fn().mockResolvedValue({ id: 'task-a' }),
  };
  return {
    service: new QuotaDispatchService(quotaDesiredRepo as never, lifecycleHooks as never),
    quotaDesiredRepo,
    lifecycleHooks,
  };
}

describe('QuotaDispatchService', () => {
  it('persists desired quota state and enqueues durable quota reconcile work', async () => {
    const { service, quotaDesiredRepo, lifecycleHooks } = makeService();

    await expect(service.apply(makeRequest())).resolves.toBeUndefined();

    expect(quotaDesiredRepo.findOne).toHaveBeenCalledWith({
      where: { serverId: 'server-a', userId: 'user-a' },
    });
    expect(quotaDesiredRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'server-a',
      userId: 'user-a',
      numericUserId: 1001,
      limitBytes: 4096,
      source: 'grant',
      generation: 1,
      lastOperationId: null,
    }));
    expect(lifecycleHooks.enqueue).toHaveBeenCalledWith({
      hook: HookKind.Quota,
      resourceType: 'quota',
      resourceId: 'user-a',
      serverId: 'server-a',
      desiredGeneration: 1,
      result: {
        source: 'quota_dispatch',
        requestedBy: 'actor-a',
        numericUserId: 1001,
        diskBytes: 4096,
      },
    });
  });

  it('increments existing desired generation and serializes queued dispatches', async () => {
    const calls: string[] = [];
    const quotaDesiredRepo = {
      findOne: vi.fn()
        .mockResolvedValueOnce({ id: 'quota-a', generation: 2, lastOperationId: 'operation-a' })
        .mockResolvedValueOnce({ id: 'quota-a', generation: 3, lastOperationId: 'operation-a' }),
      create: vi.fn((input) => input),
      save: vi.fn(async (input) => {
        calls.push(`save:${input.generation}`);
        return input;
      }),
    };
    const lifecycleHooks = {
      enqueue: vi.fn(async (input) => {
        calls.push(`hook:${input.desiredGeneration}`);
      }),
    };
    const service = new QuotaDispatchService(quotaDesiredRepo as never, lifecycleHooks as never);

    await Promise.all([
      service.apply(makeRequest({ diskBytes: 8192 })),
      service.apply(makeRequest({ diskBytes: 16_384, requestedBy: null })),
    ]);

    expect(calls).toEqual(['save:3', 'hook:3', 'save:4', 'hook:4']);
    expect(lifecycleHooks.enqueue).toHaveBeenNthCalledWith(1, expect.objectContaining({
      desiredGeneration: 3,
      result: expect.objectContaining({ requestedBy: 'actor-a', diskBytes: 8192 }),
    }));
    expect(lifecycleHooks.enqueue).toHaveBeenNthCalledWith(2, expect.objectContaining({
      desiredGeneration: 4,
      result: expect.objectContaining({ requestedBy: null, diskBytes: 16_384 }),
    }));
  });
});
