import { describe, expect, it } from 'vitest';
import {
  NVIDIA_GPU_DUPLICATE_PCI,
  NVIDIA_GPU_INVALID_PCI,
  NVIDIA_GPU_WILDCARD_FORBIDDEN,
  PackageHttpError,
} from './errors.js';
import {
  parsePciAddressList,
  zNvidiaGpuContainerState,
  zNvidiaGpuGrant,
} from './schema.js';

describe('zNvidiaGpuContainerState', () => {
  it('accepts zero-card runtime-on state', () => {
    expect(zNvidiaGpuContainerState.parse({
      nvidiaRuntime: true,
      pciAddresses: [],
    })).toEqual({ nvidiaRuntime: true, pciAddresses: [] });
  });

  it('canonicalizes PCI addresses', () => {
    expect(zNvidiaGpuContainerState.parse({
      nvidiaRuntime: true,
      pciAddresses: ['0000:41:00.0'],
    }).pciAddresses).toEqual(['00000000:41:00.0']);
  });

  it('rejects duplicate PCI (including 4-hex / 8-hex aliases)', () => {
    expect(zNvidiaGpuContainerState.safeParse({
      nvidiaRuntime: true,
      pciAddresses: ['0000:41:00.0', '00000000:41:00.0'],
    }).success).toBe(false);
  });

  it('rejects wildcard PCI', () => {
    const result = zNvidiaGpuContainerState.safeParse({
      nvidiaRuntime: true,
      pciAddresses: ['0000:41:00.*'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(zNvidiaGpuContainerState.safeParse({
      nvidiaRuntime: true,
      pciAddresses: [],
      extra: true,
    }).success).toBe(false);
  });

  it('rejects PCI assignments without nvidiaRuntime', () => {
    expect(zNvidiaGpuContainerState.safeParse({
      nvidiaRuntime: false,
      pciAddresses: ['0000:41:00.0'],
    }).success).toBe(false);
  });
});

describe('zNvidiaGpuGrant', () => {
  it('stores a PCI list, including an empty list', () => {
    expect(zNvidiaGpuGrant.parse({ pciAddresses: [] })).toEqual({ pciAddresses: [] });
    expect(zNvidiaGpuGrant.parse({
      pciAddresses: ['0000:41:00.0'],
    })).toEqual({
      pciAddresses: ['00000000:41:00.0'],
    });
  });

  it('rejects a mode field and duplicate addresses', () => {
    expect(zNvidiaGpuGrant.safeParse({
      mode: 'all',
      pciAddresses: [],
    }).success).toBe(false);
    expect(zNvidiaGpuGrant.safeParse({
      pciAddresses: ['0000:41:00.0', '0000:41:00.0'],
    }).success).toBe(false);
  });
});

describe('parsePciAddressList', () => {
  it('throws NVIDIA_GPU_WILDCARD_FORBIDDEN for asterisk selectors', () => {
    try {
      parsePciAddressList(['0000:41:00.*']);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PackageHttpError);
      expect((error as PackageHttpError).code).toBe(NVIDIA_GPU_WILDCARD_FORBIDDEN);
    }
  });

  it('throws NVIDIA_GPU_DUPLICATE_PCI for aliases of the same card', () => {
    try {
      parsePciAddressList(['0000:41:00.0', '00000000:41:00.0']);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PackageHttpError);
      expect((error as PackageHttpError).code).toBe(NVIDIA_GPU_DUPLICATE_PCI);
    }
  });

  it('throws NVIDIA_GPU_INVALID_PCI for malformed addresses', () => {
    try {
      parsePciAddressList(['not-a-pci']);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PackageHttpError);
      expect((error as PackageHttpError).code).toBe(NVIDIA_GPU_INVALID_PCI);
    }
  });
});
