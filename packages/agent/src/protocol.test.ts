import { describe, expect, it } from 'vitest';
import {
  CORE_NODE_METRIC_CATALOG,
  OpenMetricsSchemaError,
  parseOpenMetrics,
} from '@nyabase/common';

describe('node exporter OpenMetrics contract', () => {
  it('accepts core CPU samples', () => {
    const samples = parseOpenMetrics(
      'nyabase_node_cpu_usage_ratio{cpu="0"} 0.5',
      CORE_NODE_METRIC_CATALOG,
    );
    expect(samples).toEqual([
      { name: 'nyabase_node_cpu_usage_ratio', labels: { cpu: '0' }, value: 0.5 },
    ]);
  });

  it('rejects non-allowlisted or sensitive labels', () => {
    expect(() => parseOpenMetrics(
      'nyabase_node_cpu_usage_ratio{cpu="0",pid="123"} 0.5',
      CORE_NODE_METRIC_CATALOG,
    )).toThrow(OpenMetricsSchemaError);
    expect(() => parseOpenMetrics(
      'unknown_metric{value="x"} 1',
      CORE_NODE_METRIC_CATALOG,
    )).toThrow(OpenMetricsSchemaError);
  });
});
