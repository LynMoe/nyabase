import { describe, expect, it } from 'vitest';
import { NODE_METRIC_CATALOG } from '../node-metric-catalog.js';
import { OpenMetricsSchemaError, validateNodeMetricSample } from '../protocol/node-metrics.js';

describe('NODE_METRIC_CATALOG GPU families', () => {
  it('accepts GPU samples and canonicalizes the PCI label', () => {
    const sample = validateNodeMetricSample(
      { name: 'nyabase_node_gpu_util_ratio', labels: { gpu_pci: '0000:41:00.0' }, value: 0.5 },
      NODE_METRIC_CATALOG,
    );
    expect(sample.labels).toEqual({ gpu_pci: '00000000:41:00.0' });
  });

  it('rejects non-PCI GPU labels and unknown container ids', () => {
    expect(() => validateNodeMetricSample(
      { name: 'nyabase_node_gpu_power_watts', labels: { gpu_pci: 'GPU-0' }, value: 1 },
      NODE_METRIC_CATALOG,
    )).toThrow(OpenMetricsSchemaError);
    expect(() => validateNodeMetricSample(
      {
        name: 'nyabase_node_gpu_process_mem_used_bytes',
        labels: { gpu_pci: '0000:41:00.0', container_id: 'nope' },
        value: 1,
      },
      NODE_METRIC_CATALOG,
    )).toThrow(OpenMetricsSchemaError);
  });

  it('still carries the core families', () => {
    expect(NODE_METRIC_CATALOG.definitions.nyabase_node_mem_used_bytes).toBeDefined();
  });
});
