import type { ExtensionSupportCheckDto, NodeMetricSample } from '@nyabase/common';
import { summarizeExtensionSupport } from '@nyabase/common';
import {
  NVIDIA_GPU_DRIVER_PRESENT_METRIC,
  NVIDIA_GPU_TOOLKIT_PRESENT_METRIC,
} from '../metrics.js';
import { nvidiaGpuInventoryFromResources } from './inventory.js';

function presenceValue(
  samples: readonly NodeMetricSample[],
  name: string,
): boolean | undefined {
  const sample = samples.find((item) => item.name === name);
  if (!sample) return undefined;
  return sample.value > 0;
}

function driverStatus(samples: readonly NodeMetricSample[]): ExtensionSupportCheckDto {
  const present = presenceValue(samples, NVIDIA_GPU_DRIVER_PRESENT_METRIC);
  if (present === true) {
    return { id: 'nvidia-driver', label: 'NVIDIA 驱动 (nvidia-smi)', status: 'pass' };
  }
  if (present === false) {
    return {
      id: 'nvidia-driver',
      label: 'NVIDIA 驱动 (nvidia-smi)',
      status: 'fail',
      detail: 'nvidia-smi 不可用',
    };
  }
  const legacyGpuSample = samples.some((sample) => (
    sample.name.startsWith('nyabase_node_gpu_')
    && sample.name !== NVIDIA_GPU_DRIVER_PRESENT_METRIC
    && sample.name !== NVIDIA_GPU_TOOLKIT_PRESENT_METRIC
  ));
  if (legacyGpuSample) {
    return { id: 'nvidia-driver', label: 'NVIDIA 驱动 (nvidia-smi)', status: 'pass' };
  }
  return {
    id: 'nvidia-driver',
    label: 'NVIDIA 驱动 (nvidia-smi)',
    status: 'unknown',
    detail: '未采集到 node-exporter 指标',
  };
}

function toolkitStatus(samples: readonly NodeMetricSample[]): ExtensionSupportCheckDto {
  const present = presenceValue(samples, NVIDIA_GPU_TOOLKIT_PRESENT_METRIC);
  if (present === true) {
    return {
      id: 'nvidia-container-toolkit',
      label: 'NVIDIA Container Toolkit',
      status: 'pass',
    };
  }
  if (present === false) {
    return {
      id: 'nvidia-container-toolkit',
      label: 'NVIDIA Container Toolkit',
      status: 'fail',
      detail: 'nvidia-container-cli / nvidia-container-runtime 不可用',
    };
  }
  return {
    id: 'nvidia-container-toolkit',
    label: 'NVIDIA Container Toolkit',
    status: 'unknown',
    detail: '未采集到 node-exporter 指标',
  };
}

export function probeNvidiaGpuSupport(input: {
  readonly resources: unknown;
  readonly metricSamples: readonly NodeMetricSample[];
}) {
  const incusReachable = input.resources !== undefined && input.resources !== null;
  const cards = incusReachable ? nvidiaGpuInventoryFromResources(input.resources) : [];
  const checks: ExtensionSupportCheckDto[] = [
    incusReachable
      ? { id: 'incus-resources', label: 'Incus 资源可达', status: 'pass' }
      : {
          id: 'incus-resources',
          label: 'Incus 资源可达',
          status: 'unknown',
          detail: '无法读取 Incus /1.0/resources',
        },
    !incusReachable
      ? {
          id: 'nvidia-cards',
          label: 'NVIDIA GPU 设备',
          status: 'unknown',
          detail: '无法读取 Incus 资源',
        }
      : cards.length > 0
        ? {
            id: 'nvidia-cards',
            label: 'NVIDIA GPU 设备',
            status: 'pass',
            detail: `发现 ${cards.length} 张卡`,
          }
        : {
            id: 'nvidia-cards',
            label: 'NVIDIA GPU 设备',
            status: 'fail',
            detail: '未发现 NVIDIA GPU',
          },
    driverStatus(input.metricSamples),
    toolkitStatus(input.metricSamples),
  ];
  return summarizeExtensionSupport(checks);
}
