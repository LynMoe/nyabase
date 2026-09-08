import { OpenMetricsSchemaError, type NodeMetricDefinition } from '@nyabase/common';
import { canonicalPciAddress } from './pci.js';

export const NVIDIA_GPU_DRIVER_PRESENT_METRIC = 'nyabase_node_gpu_driver_present';
export const NVIDIA_GPU_TOOLKIT_PRESENT_METRIC = 'nyabase_node_gpu_toolkit_present';
export const NVIDIA_GPU_SMI_INDEX_METRIC = 'nyabase_node_gpu_smi_index';

export const NVIDIA_GPU_METRIC_DEFINITIONS: Readonly<Record<string, NodeMetricDefinition>> = {
  [NVIDIA_GPU_DRIVER_PRESENT_METRIC]: { type: 'gauge', labels: [] },
  [NVIDIA_GPU_TOOLKIT_PRESENT_METRIC]: { type: 'gauge', labels: [] },
  nyabase_node_gpu_util_ratio: { type: 'gauge', labels: ['gpu_pci'] },
  nyabase_node_gpu_mem_used_bytes: { type: 'gauge', labels: ['gpu_pci'] },
  nyabase_node_gpu_mem_total_bytes: { type: 'gauge', labels: ['gpu_pci'] },
  nyabase_node_gpu_temperature_celsius: { type: 'gauge', labels: ['gpu_pci'] },
  nyabase_node_gpu_power_watts: { type: 'gauge', labels: ['gpu_pci'] },
  [NVIDIA_GPU_SMI_INDEX_METRIC]: { type: 'gauge', labels: ['gpu_pci'] },
  nyabase_node_gpu_process_mem_used_bytes: {
    type: 'gauge',
    labels: ['gpu_pci', 'container_id'],
  },
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateNvidiaGpuLabels(
  labels: Readonly<Record<string, string>>,
): Record<string, string> {
  const normalized: Record<string, string> = { ...labels };
  if (normalized.gpu_pci !== undefined) {
    const pci = canonicalPciAddress(normalized.gpu_pci);
    if (!pci) {
      throw new OpenMetricsSchemaError('GPU labels must use PCI addresses');
    }
    normalized.gpu_pci = pci;
  }
  if (normalized.container_id !== undefined) {
    if (normalized.container_id !== '__unattributed__' && !UUID_PATTERN.test(normalized.container_id)) {
      throw new OpenMetricsSchemaError('Container labels must use nyabase UUIDs');
    }
  }
  return normalized;
}

export const NVIDIA_GPU_LABEL_VALIDATORS: Readonly<
  Record<string, (labels: Readonly<Record<string, string>>) => Record<string, string>>
> = Object.fromEntries(
  Object.keys(NVIDIA_GPU_METRIC_DEFINITIONS).map((name) => [name, validateNvidiaGpuLabels]),
);
