import { describe, expect, it } from 'vitest';
import { contributeNvidiaGpuInstanceSpec, nvidiaGpuRequiresStop } from './instance-spec.js';

describe('contributeNvidiaGpuInstanceSpec', () => {
  it('returns empty config/devices when the key is missing or empty', () => {
    expect(contributeNvidiaGpuInstanceSpec(undefined)).toEqual({ config: {}, devices: {} });
    expect(contributeNvidiaGpuInstanceSpec({})).toEqual({ config: {}, devices: {} });
    expect(contributeNvidiaGpuInstanceSpec(null)).toEqual({ config: {}, devices: {} });
  });

  it('projects runtime-on zero-card state without gpu devices', () => {
    expect(contributeNvidiaGpuInstanceSpec({
      nvidiaRuntime: true,
      pciAddresses: [],
    })).toEqual({
      config: { 'nvidia.runtime': 'true' },
      devices: {},
    });
  });

  it('emits Incus 4-hex PCI devices from stored canonical addresses', () => {
    expect(contributeNvidiaGpuInstanceSpec({
      nvidiaRuntime: true,
      pciAddresses: ['00000000:41:00.0', '0000:a1:00.0'],
    })).toEqual({
      config: { 'nvidia.runtime': 'true' },
      devices: {
        gpu0: { type: 'gpu', gputype: 'physical', pci: '0000:41:00.0' },
        gpu1: { type: 'gpu', gputype: 'physical', pci: '0000:a1:00.0' },
      },
    });
  });

  it('does not leak admitCreate defaults into an empty projection', () => {
    const empty = contributeNvidiaGpuInstanceSpec(undefined);
    expect(empty.config).not.toHaveProperty('nvidia.runtime');
    expect(Object.keys(empty.devices)).toEqual([]);
  });
});

describe('nvidiaGpuRequiresStop', () => {
  it('returns true only for nvidia. config or gpu device diffs', () => {
    expect(nvidiaGpuRequiresStop({
      config: { 'nvidia.runtime': { actual: 'false', desired: 'true' } },
      devices: {},
    })).toBe(true);
    expect(nvidiaGpuRequiresStop({
      config: {},
      devices: { gpu0: { actual: undefined, desired: { type: 'gpu' } } },
    })).toBe(true);
    expect(nvidiaGpuRequiresStop({
      config: { 'limits.cpu': { actual: '1', desired: '2' } },
      devices: { eth0: { actual: {}, desired: {} } },
    })).toBe(false);
  });
});
