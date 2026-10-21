import { describe, expect, it } from 'vitest';
import { FailureCode } from '@nyabase/common';
import {
  admitGpuCreate,
  mutateGpuContainer,
  gpuErrorBody,
  type GpuClaimsPort,
  type GpuContext,
  type GpuHealthPort,
} from './admit.js';

function createClaims(occupied: string[] = []): GpuClaimsPort & { keys: string[] } {
  const keys = [...occupied];
  return {
    keys,
    replace: async (deviceKeys) => {
      keys.splice(0, keys.length, ...deviceKeys);
    },
    listOccupied: async () => [...keys],
    count: async () => keys.length,
  };
}

function createHealth(runtimeReady: boolean | null | undefined): GpuHealthPort {
  const health: Record<string, unknown> = runtimeReady === undefined
    ? {}
    : { runtimeReady };
  return {
    read: async () => ({ ...health }),
    write: async (next) => {
      Object.assign(health, next);
    },
  };
}

function baseCtx(overrides: Partial<GpuContext> = {}): GpuContext {
  return {
    serverId: '22222222-2222-4222-8222-222222222222',
    actor: { userId: '11111111-1111-4111-8111-111111111111', admin: false },
    grantPciAddresses: [],
    claims: createClaims(),
    health: createHealth(true),
    ...overrides,
  };
}

describe('admitGpuCreate', () => {
  it('writes nvidiaRuntime true with zero cards when enabled and ready', async () => {
    const result = await admitGpuCreate({
      ...baseCtx(),
      containerId: '33333333-3333-4333-8333-333333333333',
      requestedPciAddresses: undefined,
      enabled: true,
    });
    expect(result.state).toEqual({ nvidiaRuntime: true, pciAddresses: [] });
  });

  it('returns empty state when disabled and payload is omitted', async () => {
    const result = await admitGpuCreate({
      ...baseCtx({ health: createHealth(false) }),
      containerId: '33333333-3333-4333-8333-333333333333',
      requestedPciAddresses: undefined,
      enabled: false,
    });
    expect(result.state).toBeNull();
  });

  it('does not open runtime when enabled but not ready and no cards are requested', async () => {
    const result = await admitGpuCreate({
      ...baseCtx({ health: createHealth(false) }),
      containerId: '33333333-3333-4333-8333-333333333333',
      requestedPciAddresses: undefined,
      enabled: true,
    });
    expect(result.state).toEqual({ nvidiaRuntime: false, pciAddresses: [] });
  });

  it('rejects cards when enabled but runtimeReady is false', async () => {
    try {
      await admitGpuCreate({
        ...baseCtx({ health: createHealth(false) }),
        containerId: '33333333-3333-4333-8333-333333333333',
        requestedPciAddresses: ['0000:41:00.0'],
        enabled: true,
      });
      expect.unreachable();
    } catch (error) {
      expect(gpuErrorBody(error)?.code).toBe(FailureCode.GpuRuntimeUnavailable);
    }
  });

  it('treats missing runtimeReady as unknown and allows cards', async () => {
    const claims = createClaims();
    const result = await admitGpuCreate({
      ...baseCtx({ health: createHealth(undefined), claims }),
      actor: { userId: '11111111-1111-4111-8111-111111111111', admin: true },
      containerId: '33333333-3333-4333-8333-333333333333',
      requestedPciAddresses: ['0000:41:00.0'],
      enabled: true,
    });
    expect(result.state).toEqual({
      nvidiaRuntime: true,
      pciAddresses: ['00000000:41:00.0'],
    });
    expect(claims.keys).toEqual(['00000000:41:00.0']);
  });

  it('denies user cards outside a none grant', async () => {
    try {
      await admitGpuCreate({
        ...baseCtx({
          grantPciAddresses: [],
        }),
        containerId: '33333333-3333-4333-8333-333333333333',
        requestedPciAddresses: ['0000:41:00.0'],
        enabled: true,
      });
      expect.unreachable();
    } catch (error) {
      expect(gpuErrorBody(error)?.code).toBe(FailureCode.PermissionDenied);
    }
  });
});

type MutateCtx = GpuContext & {
  readonly containerId: string;
  readonly observedStatus: 'running' | 'stopped' | 'frozen' | 'error' | 'unknown';
  readonly currentState: unknown;
  readonly payload: unknown;
  readonly enabled: boolean;
};

describe('mutateGpuContainer', () => {
  function mutateCtx(
    overrides: Partial<MutateCtx> = {},
  ): MutateCtx {
    return {
      ...baseCtx(),
      containerId: '33333333-3333-4333-8333-333333333333',
      observedStatus: 'stopped',
      currentState: null,
      payload: { pciAddresses: [] },
      enabled: true,
      ...overrides,
    };
  }

  it('opens nvidiaRuntime when a stopped container with runtime false adds cards', async () => {
    const result = await mutateGpuContainer(mutateCtx({
      actor: { userId: '11111111-1111-4111-8111-111111111111', admin: true },
      currentState: { nvidiaRuntime: false, pciAddresses: [] },
      payload: { pciAddresses: ['0000:41:00.0'] },
    }));
    expect(result.state).toEqual({
      nvidiaRuntime: true,
      pciAddresses: ['00000000:41:00.0'],
    });
  });

  it('keeps nvidiaRuntime true when clearing cards', async () => {
    const claims = createClaims(['00000000:41:00.0']);
    const result = await mutateGpuContainer(mutateCtx({
      claims,
      currentState: {
          nvidiaRuntime: true,
          pciAddresses: ['00000000:41:00.0'],
        },
      payload: { pciAddresses: [] },
    }));
    expect(result.state).toEqual({ nvidiaRuntime: true, pciAddresses: [] });
    expect(claims.keys).toEqual([]);
  });

  it('rejects assignment changes while not stopped', async () => {
    try {
      await mutateGpuContainer(mutateCtx({
        observedStatus: 'running',
        currentState: { nvidiaRuntime: true, pciAddresses: [] },
        payload: { pciAddresses: ['0000:41:00.0'] },
      }));
      expect.unreachable();
    } catch (error) {
      expect(gpuErrorBody(error)?.code).toBe(FailureCode.GpuMutationRequiresStop);
    }
  });

  it('rejects frozen containers the same as running', async () => {
    try {
      await mutateGpuContainer(mutateCtx({
        observedStatus: 'frozen',
        actor: { userId: '11111111-1111-4111-8111-111111111111', admin: true },
        payload: { pciAddresses: ['0000:41:00.0'] },
      }));
      expect.unreachable();
    } catch (error) {
      expect(gpuErrorBody(error)?.code).toBe(FailureCode.GpuMutationRequiresStop);
    }
  });

  it('rejects admin claims that collide with occupancy', async () => {
    try {
      await mutateGpuContainer(mutateCtx({
        actor: { userId: '11111111-1111-4111-8111-111111111111', admin: true },
        claims: createClaims(['00000000:41:00.0']),
        payload: { pciAddresses: ['0000:41:00.0'] },
      }));
      expect.unreachable();
    } catch (error) {
      expect(gpuErrorBody(error)?.code).toBe(FailureCode.GpuDeviceClaimed);
    }
  });

  it('returns empty state for a missing key and empty PCI even while running', async () => {
    const result = await mutateGpuContainer(mutateCtx({
      observedStatus: 'running',
      currentState: null,
      payload: { pciAddresses: [] },
    }));
    expect(result.state).toBeNull();
  });

  it('does not materialize runtime-false from a no-op mutate of a missing key', async () => {
    const result = await mutateGpuContainer(mutateCtx({
      currentState: null,
      payload: { pciAddresses: [] },
    }));
    expect(result.state).toBeNull();
  });

  it('does not throw when the assignment is unchanged while running', async () => {
    const result = await mutateGpuContainer(mutateCtx({
      observedStatus: 'running',
      currentState: {
          nvidiaRuntime: true,
          pciAddresses: ['00000000:41:00.0'],
        },
      payload: { pciAddresses: ['0000:41:00.0'] },
      actor: { userId: '11111111-1111-4111-8111-111111111111', admin: true },
    }));
    expect(result.state).toEqual({
      nvidiaRuntime: true,
      pciAddresses: ['00000000:41:00.0'],
    });
  });
});


