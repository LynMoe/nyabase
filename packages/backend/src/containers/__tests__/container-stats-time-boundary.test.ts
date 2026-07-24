import { describe, expect, it, vi } from 'vitest';
import type { ContainerView } from '@nyabase/common';
import { ContainerControlService } from '../container-control.service.js';

describe('ContainerControlService stats time boundary', () => {
  it('does not project an invalid cached Agent epoch', async () => {
    const service = Object.create(ContainerControlService.prototype) as ContainerControlService;
    Object.defineProperty(service, 'agentGateway', {
      value: { stateCache: { get: vi.fn().mockReturnValue({ lastUpdated: 1e300 }) } },
    });
    const view = {
      id: 'container-a',
      serverId: 'server-a',
      runtime: { runtimeId: 'runtime-a' },
      actions: { stats: { enabled: true } },
    } as unknown as ContainerView;

    const result = await (service as unknown as {
      statsForView(value: ContainerView): Promise<{
        containerId: string;
        stats: null;
        ts: number;
        lastObservedAt?: string;
      }>;
    }).statsForView(view);

    expect(result).toMatchObject({ containerId: 'container-a', stats: null });
    expect(Number.isSafeInteger(result.ts)).toBe(true);
    expect(result).not.toHaveProperty('lastObservedAt');
  });
});
