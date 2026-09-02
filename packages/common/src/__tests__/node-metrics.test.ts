import { describe, expect, it } from 'vitest';
import {
  mergeNodeMetricCatalog,
  OpenMetricsSchemaError,
  parseOpenMetrics,
  renderOpenMetrics,
  validateNodeMetricSample,
} from '../protocol/node-metrics.js';

function gpuSample(pci: string) {
  return {
    name: 'nyabase_node_gpu_util_ratio' as const,
    labels: { gpu_pci: pci },
    value: 0.25,
  };
}

describe('node metrics GPU PCI schema', () => {
  it('accepts four-digit and NVIDIA eight-digit PCI domains', () => {
    const samples = [
      gpuSample('0000:41:00.0'),
      gpuSample('00000000:41:00.0'),
    ];

    for (const input of samples) {
      const canonical = gpuSample('00000000:41:00.0');
      expect(validateNodeMetricSample(input)).toEqual(canonical);
      expect(renderOpenMetrics([input])).toContain(`gpu_pci="${canonical.labels.gpu_pci}"`);
      expect(parseOpenMetrics(
        `nyabase_node_gpu_util_ratio{gpu_pci="${input.labels.gpu_pci}"} 0.25`,
      )).toEqual([canonical]);
    }
  });

  it('rejects malformed PCI addresses and display-index fallbacks', () => {
    const malformed = [
      '0',
      '1',
      '000:41:00.0',
      '0000000:41:00.0',
      '000000000:41:00.0',
      '0000:41:00',
      '0000:41:00.8',
      '0000:41:00.f',
      'GPU-0',
    ];

    for (const pci of malformed) {
      expect(() => validateNodeMetricSample(gpuSample(pci)))
        .toThrow(OpenMetricsSchemaError);
    }
  });

  it('accepts unlabeled nft gauges and IPv4 address labels', () => {
    expect(validateNodeMetricSample({
      name: 'nyabase_node_network_nft_available',
      labels: {},
      value: 1,
    })).toEqual({
      name: 'nyabase_node_network_nft_available',
      labels: {},
      value: 1,
    });
    expect(renderOpenMetrics([{
      name: 'nyabase_node_network_nft_available',
      labels: {},
      value: 1,
    }])).toContain('nyabase_node_network_nft_available{} 1');
    expect(validateNodeMetricSample({
      name: 'nyabase_node_network_bridge_filter_address',
      labels: { address: '192.0.2.10' },
      value: 1,
    }).labels.address).toBe('192.0.2.10');
    expect(() => validateNodeMetricSample({
      name: 'nyabase_node_network_bridge_filter_address',
      labels: { address: 'not-an-ip' },
      value: 1,
    })).toThrow(OpenMetricsSchemaError);
    expect(validateNodeMetricSample({
      name: 'nyabase_node_network_bridge_slave',
      labels: { bridge: 'vmbr0', interface: 'bond0' },
      value: 1,
    })).toMatchObject({
      labels: { bridge: 'vmbr0', interface: 'bond0' },
    });
  });

  it('treats four- and eight-digit domains as the same metric identity', () => {
    expect(() => parseOpenMetrics([
      'nyabase_node_gpu_util_ratio{gpu_pci="0000:41:00.0"} 0.25',
      'nyabase_node_gpu_util_ratio{gpu_pci="00000000:41:00.0"} 0.5',
    ].join('\n'))).toThrow('Duplicate metric sample');
  });
});

describe('mergeNodeMetricCatalog', () => {
  it('merges disjoint families and rejects collisions', () => {
    const merged = mergeNodeMetricCatalog(
      { definitions: { a: { type: 'gauge', labels: [] } }, validators: {} },
      {
        definitions: { b: { type: 'counter', labels: ['id'] } },
        validators: { b: (labels) => ({ ...labels }) },
      },
    );
    expect(merged.definitions).toEqual({
      a: { type: 'gauge', labels: [] },
      b: { type: 'counter', labels: ['id'] },
    });
    expect(merged.validators.b).toEqual(expect.any(Function));
    expect(() => mergeNodeMetricCatalog(
      { definitions: { a: { type: 'gauge', labels: [] } }, validators: {} },
      { definitions: { a: { type: 'gauge', labels: [] } }, validators: {} },
    )).toThrow('node metric catalog collision: a');
  });
});
