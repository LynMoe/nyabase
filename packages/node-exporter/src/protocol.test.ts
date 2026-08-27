import { describe, expect, it } from 'vitest';
import { OpenMetricsSchemaError, parseOpenMetrics } from '@nyabase/common';

describe('node exporter OpenMetrics contract', () => {
  it('accepts PCI keyed GPU samples and unattributed processes', () => {
    const samples = parseOpenMetrics([
      'nyabase_node_gpu_util_ratio{gpu_pci="0000:41:00.0"} 0.5',
      'nyabase_node_gpu_process_mem_used_bytes{container_id="__unattributed__",gpu_pci="0000:41:00.0"} 1024',
    ].join('\n'));
    expect(samples).toHaveLength(2);
    expect(samples.every((sample) => sample.labels.gpu_pci === '00000000:41:00.0')).toBe(true);
  });

  it('rejects non-allowlisted or sensitive labels', () => {
    expect(() => parseOpenMetrics(
      'nyabase_node_gpu_util_ratio{gpu_pci="0"} 0.5',
    )).toThrow(OpenMetricsSchemaError);
    expect(() => parseOpenMetrics(
      'nyabase_node_cpu_usage_ratio{cpu="0",pid="123"} 0.5',
    )).toThrow(OpenMetricsSchemaError);
    expect(() => parseOpenMetrics(
      'unknown_metric{value="x"} 1',
    )).toThrow(OpenMetricsSchemaError);
  });
});
