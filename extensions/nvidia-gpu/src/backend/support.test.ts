import { describe, expect, it } from 'vitest';
import type { ExtensionSupportCheckDto } from '@nyabase/common';
import {
  NVIDIA_GPU_DRIVER_PRESENT_METRIC,
  NVIDIA_GPU_SMI_INDEX_METRIC,
  NVIDIA_GPU_TOOLKIT_PRESENT_METRIC,
} from '../metrics.js';
import { probeNvidiaGpuSupport } from './support.js';

function byId(checks: readonly ExtensionSupportCheckDto[], id: string) {
  return checks.find((check) => check.id === id);
}

const nvidiaResources = {
  gpu: { cards: [{ pci_address: '0000:41:00.0', nvidia: { model: 'A100' } }] },
};

describe('probeNvidiaGpuSupport', () => {
  it('is unknown when Incus and exporter evidence are both missing', () => {
    const result = probeNvidiaGpuSupport({ resources: null, metricSamples: [] });
    expect(result.supported).toBeNull();
    expect(result.checks.map((check) => [check.id, check.status])).toEqual([
      ['incus-resources', 'unknown'],
      ['nvidia-cards', 'unknown'],
      ['nvidia-driver', 'unknown'],
      ['nvidia-container-toolkit', 'unknown'],
    ]);
  });

  it('fails when Incus is reachable but has no NVIDIA cards', () => {
    const result = probeNvidiaGpuSupport({
      resources: { gpu: { cards: [] } },
      metricSamples: [],
    });
    expect(result.supported).toBe(false);
    expect(byId(result.checks, 'nvidia-cards')).toMatchObject({
      status: 'fail',
    });
  });

  it('is fully supported when cards, driver, and toolkit are present', () => {
    const result = probeNvidiaGpuSupport({
      resources: nvidiaResources,
      metricSamples: [
        { name: NVIDIA_GPU_DRIVER_PRESENT_METRIC, labels: {}, value: 1 },
        { name: NVIDIA_GPU_TOOLKIT_PRESENT_METRIC, labels: {}, value: 1 },
      ],
    });
    expect(result.supported).toBe(true);
    expect(byId(result.checks, 'nvidia-cards')?.detail).toBe('发现 1 张卡');
  });

  it('fails when the exporter reports a missing driver', () => {
    const result = probeNvidiaGpuSupport({
      resources: nvidiaResources,
      metricSamples: [
        { name: NVIDIA_GPU_DRIVER_PRESENT_METRIC, labels: {}, value: 0 },
        { name: NVIDIA_GPU_TOOLKIT_PRESENT_METRIC, labels: {}, value: 1 },
      ],
    });
    expect(result.supported).toBe(false);
    expect(byId(result.checks, 'nvidia-driver')?.status).toBe('fail');
  });

  it('treats legacy GPU metric samples as driver evidence', () => {
    const result = probeNvidiaGpuSupport({
      resources: nvidiaResources,
      metricSamples: [
        { name: NVIDIA_GPU_SMI_INDEX_METRIC, labels: { gpu_pci: '00000000:41:00.0' }, value: 0 },
      ],
    });
    expect(byId(result.checks, 'nvidia-driver')?.status).toBe('pass');
    expect(byId(result.checks, 'nvidia-container-toolkit')?.status).toBe('unknown');
    expect(result.supported).toBeNull();
  });
});
