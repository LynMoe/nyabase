import { describe, expect, it } from 'vitest';
import { FailureCode } from '@nyabase/common';
import {
  assertGpuCanDisable,
  isGpuOccupiedSqlError,
  gpuErrorBody,
  type GpuClaimsPort,
  type GpuHealthPort,
} from './admit.js';
import { gpuPreflight, refreshGpuHealth, probeGpuSupport } from './inventory.js';
import { GPU_CONFIG_PREFIXES, GPU_DEVICE_PREFIXES } from './instance-spec.js';

function createClaims(count = 0): GpuClaimsPort {
  let keys = Array.from({ length: count }, (_, index) => `00000000:41:0${index}.0`);
  return {
    replace: async (pciAddresses) => {
      keys = [...pciAddresses];
    },
    count: async () => keys.length,
  };
}

function createHealth(): GpuHealthPort {
  let health: Record<string, unknown> = {};
  return {
    read: async () => ({ ...health }),
    write: async (next) => {
      health = { ...next };
    },
  };
}

describe('gpu feature', () => {
  it('owns the NVIDIA Incus config and device prefixes', () => {
    expect(GPU_CONFIG_PREFIXES).toEqual(['nvidia.']);
    expect(GPU_DEVICE_PREFIXES).toEqual(['gpu']);
  });

  it('refreshes health from Incus nvidia cards without treating exporter absence as not-ready', async () => {
    const health = createHealth();
    await refreshGpuHealth({
      health,
      resources: { gpu: { cards: [{ pci_address: '0000:41:00.0', nvidia: { model: 'A' } }] } },
      metricSamples: [],
    });
    expect(await health.read()).toMatchObject({
      runtimeReady: true,
      nvidiaCardCount: 1,
      exporterGpuSamples: false,
    });
  });

  it('writes runtimeReady null when Incus resources are missing', async () => {
    const health = createHealth();
    await refreshGpuHealth({ health, resources: null, metricSamples: [] });
    expect(await health.read()).toMatchObject({ runtimeReady: null, nvidiaCardCount: 0 });
  });

  it('reports preflight evidence and health together', () => {
    const result = gpuPreflight({
      serverId: 's',
      resources: { gpu: { cards: [{ pci_address: '0000:41:00.0', nvidia: { model: 'A' } }] } },
      metricSamples: [{ name: 'nyabase_node_gpu_util_ratio', labels: { gpu_pci: '00000000:41:00.0' }, value: 0.1 }],
      enabled: false,
    });
    expect(result.evidence).toEqual({
      serverId: 's',
      enabled: false,
      runtimeReady: true,
      nvidiaCardCount: 1,
      exporterGpuSamples: true,
    });
    expect(result.health).toEqual({ runtimeReady: true, nvidiaCardCount: 1 });
  });

  it('probes host support independently of enablement', () => {
    const result = probeGpuSupport({
      resources: { gpu: { cards: [{ pci_address: '0000:41:00.0', nvidia: { model: 'A' } }] } },
      metricSamples: [
        { name: 'nyabase_node_gpu_driver_present', labels: {}, value: 1 },
        { name: 'nyabase_node_gpu_toolkit_present', labels: {}, value: 1 },
      ],
    });
    expect(result.supported).toBe(true);
  });

  it('blocks disable while claims remain', async () => {
    await expect(assertGpuCanDisable(createClaims(1))).rejects.toSatisfy(
      (error) => gpuErrorBody(error)?.code === FailureCode.GpuOccupied,
    );
    await expect(assertGpuCanDisable(createClaims(0))).resolves.toBeUndefined();
  });

  it('recognizes the database disable trigger error', () => {
    expect(isGpuOccupiedSqlError({ cause: { code: 'P0001', hint: 'GPU_OCCUPIED' } })).toBe(true);
    expect(isGpuOccupiedSqlError({ code: 'P0001', hint: 'OTHER' })).toBe(false);
  });
});
