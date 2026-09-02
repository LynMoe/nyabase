import { describe, expect, it } from 'vitest';
import { NVIDIA_GPU_EXTENSION_ID } from '../id.js';
import {
  NVIDIA_GPU_RUNTIME_UNAVAILABLE,
  PackageHttpError,
} from '../errors.js';
import { GpuGrantMode } from '../schema.js';
import { admitNvidiaGpuCreate, mutateNvidiaGpuContainer } from './admit.js';
import type {
  ContainerExtensionContext,
  ExtensionClaimsPort,
  ExtensionHealthPort,
  ServerCardExtensionContext,
} from '../types.js';

function createClaims(occupied: string[] = []): ExtensionClaimsPort & { keys: string[] } {
  const keys = [...occupied];
  return {
    keys,
    replace: async (deviceKeys) => {
      keys.splice(0, keys.length, ...deviceKeys);
    },
    listOccupiedKeys: async () => [...keys],
    count: async () => keys.length,
  };
}

function createHealth(runtimeReady: boolean | null | undefined): ExtensionHealthPort {
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

function baseCtx(overrides: Partial<ServerCardExtensionContext> = {}): ServerCardExtensionContext {
  return {
    serverId: '22222222-2222-4222-8222-222222222222',
    actor: { userId: '11111111-1111-4111-8111-111111111111', admin: false },
    grant: { extensionGrants: null },
    claims: createClaims(),
    health: createHealth(true),
    ...overrides,
  };
}

describe('admitNvidiaGpuCreate', () => {
  it('writes nvidiaRuntime true with zero cards when enabled and ready', async () => {
    const result = await admitNvidiaGpuCreate({
      ...baseCtx(),
      containerId: '33333333-3333-4333-8333-333333333333',
      payload: undefined,
      enabled: true,
    });
    expect(result.state).toEqual({ nvidiaRuntime: true, pciAddresses: [] });
  });

  it('returns empty state when disabled and payload is omitted', async () => {
    const result = await admitNvidiaGpuCreate({
      ...baseCtx({ health: createHealth(false) }),
      containerId: '33333333-3333-4333-8333-333333333333',
      payload: undefined,
      enabled: false,
    });
    expect(result.state).toEqual({});
  });

  it('does not open runtime when enabled but not ready and no cards are requested', async () => {
    const result = await admitNvidiaGpuCreate({
      ...baseCtx({ health: createHealth(false) }),
      containerId: '33333333-3333-4333-8333-333333333333',
      payload: undefined,
      enabled: true,
    });
    expect(result.state).toEqual({ nvidiaRuntime: false, pciAddresses: [] });
  });

  it('rejects cards when enabled but runtimeReady is false', async () => {
    try {
      await admitNvidiaGpuCreate({
        ...baseCtx({ health: createHealth(false) }),
        containerId: '33333333-3333-4333-8333-333333333333',
        payload: { pciAddresses: ['0000:41:00.0'] },
        enabled: true,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PackageHttpError);
      expect((error as PackageHttpError).code).toBe(NVIDIA_GPU_RUNTIME_UNAVAILABLE);
    }
  });

  it('treats missing runtimeReady as unknown and allows cards', async () => {
    const claims = createClaims();
    const result = await admitNvidiaGpuCreate({
      ...baseCtx({ health: createHealth(undefined), claims }),
      actor: { userId: '11111111-1111-4111-8111-111111111111', admin: true },
      containerId: '33333333-3333-4333-8333-333333333333',
      payload: { pciAddresses: ['0000:41:00.0'] },
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
      await admitNvidiaGpuCreate({
        ...baseCtx({
          grant: { extensionGrants: { [NVIDIA_GPU_EXTENSION_ID]: { mode: 'none', pciAddresses: [] } } },
        }),
        containerId: '33333333-3333-4333-8333-333333333333',
        payload: { pciAddresses: ['0000:41:00.0'] },
        enabled: true,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PackageHttpError);
      expect((error as PackageHttpError).code).toBe('PERMISSION_DENIED');
    }
  });
});

describe('mutateNvidiaGpuContainer', () => {
  function mutateCtx(
    overrides: Partial<ContainerExtensionContext & { payload: unknown; enabled: boolean }> = {},
  ): ContainerExtensionContext & { payload: unknown; enabled: boolean } {
    return {
      ...baseCtx(),
      containerId: '33333333-3333-4333-8333-333333333333',
      lifecyclePhase: 'active',
      powerIntent: 'stopped',
      observedStatus: 'stopped',
      currentExtensions: {},
      payload: { pciAddresses: [] },
      enabled: true,
      ...overrides,
    };
  }

  it('opens nvidiaRuntime when a stopped container with runtime false adds cards', async () => {
    const result = await mutateNvidiaGpuContainer(mutateCtx({
      actor: { userId: '11111111-1111-4111-8111-111111111111', admin: true },
      currentExtensions: {
        [NVIDIA_GPU_EXTENSION_ID]: { nvidiaRuntime: false, pciAddresses: [] },
      },
      payload: { pciAddresses: ['0000:41:00.0'] },
    }));
    expect(result.state).toEqual({
      nvidiaRuntime: true,
      pciAddresses: ['00000000:41:00.0'],
    });
  });

  it('keeps nvidiaRuntime true when clearing cards', async () => {
    const claims = createClaims(['00000000:41:00.0']);
    const result = await mutateNvidiaGpuContainer(mutateCtx({
      claims,
      currentExtensions: {
        [NVIDIA_GPU_EXTENSION_ID]: {
          nvidiaRuntime: true,
          pciAddresses: ['00000000:41:00.0'],
        },
      },
      payload: { pciAddresses: [] },
    }));
    expect(result.state).toEqual({ nvidiaRuntime: true, pciAddresses: [] });
    expect(claims.keys).toEqual([]);
  });

  it('rejects assignment changes while not stopped', async () => {
    try {
      await mutateNvidiaGpuContainer(mutateCtx({
        observedStatus: 'running',
        currentExtensions: {
          [NVIDIA_GPU_EXTENSION_ID]: { nvidiaRuntime: true, pciAddresses: [] },
        },
        payload: { pciAddresses: ['0000:41:00.0'] },
      }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PackageHttpError);
      expect((error as PackageHttpError).code).toBe('EXTENSION_MUTATION_REQUIRES_STOP');
    }
  });

  it('rejects frozen containers the same as running', async () => {
    try {
      await mutateNvidiaGpuContainer(mutateCtx({
        observedStatus: 'frozen',
        actor: { userId: '11111111-1111-4111-8111-111111111111', admin: true },
        payload: { pciAddresses: ['0000:41:00.0'] },
      }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PackageHttpError);
      expect((error as PackageHttpError).code).toBe('EXTENSION_MUTATION_REQUIRES_STOP');
    }
  });

  it('rejects admin claims that collide with occupancy', async () => {
    try {
      await mutateNvidiaGpuContainer(mutateCtx({
        actor: { userId: '11111111-1111-4111-8111-111111111111', admin: true },
        claims: createClaims(['00000000:41:00.0']),
        payload: { pciAddresses: ['0000:41:00.0'] },
      }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PackageHttpError);
      expect((error as PackageHttpError).code).toBe('EXTENSION_DEVICE_CLAIMED');
    }
  });

  it('does not throw when the assignment is unchanged while running', async () => {
    const result = await mutateNvidiaGpuContainer(mutateCtx({
      observedStatus: 'running',
      currentExtensions: {
        [NVIDIA_GPU_EXTENSION_ID]: {
          nvidiaRuntime: true,
          pciAddresses: ['00000000:41:00.0'],
        },
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

describe('grant mode', () => {
  it('exports none/all/pci', () => {
    expect(GpuGrantMode.None).toBe('none');
    expect(GpuGrantMode.All).toBe('all');
    expect(GpuGrantMode.Pci).toBe('pci');
  });
});
