import { describe, expect, it } from 'vitest';
import { NVIDIA_GPU_EXTENSION_ID } from '../id.js';
import { createNvidiaGpuExtension } from './extension.js';
import type { ExtensionClaimsPort, ExtensionHealthPort } from '../types.js';

function createClaims(count = 0): ExtensionClaimsPort {
  let keys = Array.from({ length: count }, (_, index) => `00000000:41:0${index}.0`);
  return {
    replace: async (deviceKeys) => {
      keys = [...deviceKeys];
    },
    listOccupiedKeys: async () => [...keys],
    count: async () => keys.length,
  };
}

function createHealth(): ExtensionHealthPort {
  let health: Record<string, unknown> = {};
  return {
    read: async () => ({ ...health }),
    write: async (next) => {
      health = { ...next };
    },
  };
}

describe('createNvidiaGpuExtension', () => {
  it('exposes NVIDIA prefixes and the main CJS factories', () => {
    const ext = createNvidiaGpuExtension();
    expect(ext.id).toBe(NVIDIA_GPU_EXTENSION_ID);
    expect(ext.ownedIncusConfigKeyPrefixes).toEqual(['nvidia.']);
    expect(ext.ownedIncusDeviceNamePrefixes).toEqual(['gpu']);
    expect(ext.metricCatalog?.definitions['nyabase_node_gpu_smi_index']).toEqual({
      type: 'gauge',
      labels: ['gpu_pci'],
    });
  });

  it('refreshes health from Incus nvidia cards without treating exporter absence as not-ready', async () => {
    const health = createHealth();
    const ext = createNvidiaGpuExtension();
    await ext.refreshHealth({
      health,
      serverId: '22222222-2222-4222-8222-222222222222',
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
    await createNvidiaGpuExtension().refreshHealth({
      health,
      serverId: '22222222-2222-4222-8222-222222222222',
      resources: null,
      metricSamples: [],
    });
    expect(await health.read()).toMatchObject({ runtimeReady: null, nvidiaCardCount: 0 });
  });

  it('probes host support independently of enablement', async () => {
    const result = await createNvidiaGpuExtension().probeSupport({
      serverId: '22222222-2222-4222-8222-222222222222',
      resources: { gpu: { cards: [{ pci_address: '0000:41:00.0', nvidia: { model: 'A' } }] } },
      metricSamples: [
        { name: 'nyabase_node_gpu_driver_present', labels: {}, value: 1 },
        { name: 'nyabase_node_gpu_toolkit_present', labels: {}, value: 1 },
      ],
    });
    expect(result.supported).toBe(true);
  });

  it('blocks disable while claims remain', async () => {
    const ext = createNvidiaGpuExtension();
    await expect(ext.assertCanDisable({
      serverId: 's',
      actor: { userId: 'u', admin: true },
      grant: { extensionGrants: null },
      claims: createClaims(1),
      health: createHealth(),
    })).rejects.toMatchObject({ code: 'EXTENSION_OCCUPIED' });
  });
});
