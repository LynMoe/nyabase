import { describe, expect, it } from 'vitest';
import {
  CORE_NODE_METRIC_CATALOG,
  mergeNodeMetricCatalog,
  OpenMetricsSchemaError,
  parseOpenMetrics,
  renderOpenMetrics,
  validateNodeMetricSample,
} from '../protocol/node-metrics.js';

describe('core node metrics catalog', () => {
  it('accepts unlabeled nft gauges and IPv4 address labels', () => {
    expect(validateNodeMetricSample({
      name: 'nyabase_node_network_nft_available',
      labels: {},
      value: 1,
    }, CORE_NODE_METRIC_CATALOG)).toEqual({
      name: 'nyabase_node_network_nft_available',
      labels: {},
      value: 1,
    });
    expect(renderOpenMetrics([{
      name: 'nyabase_node_network_nft_available',
      labels: {},
      value: 1,
    }], CORE_NODE_METRIC_CATALOG)).toContain('nyabase_node_network_nft_available{} 1');
    expect(validateNodeMetricSample({
      name: 'nyabase_node_network_bridge_filter_address',
      labels: { address: '192.0.2.10' },
      value: 1,
    }, CORE_NODE_METRIC_CATALOG).labels.address).toBe('192.0.2.10');
    expect(() => validateNodeMetricSample({
      name: 'nyabase_node_network_bridge_filter_address',
      labels: { address: 'not-an-ip' },
      value: 1,
    }, CORE_NODE_METRIC_CATALOG)).toThrow(OpenMetricsSchemaError);
    expect(validateNodeMetricSample({
      name: 'nyabase_node_network_bridge_slave',
      labels: { bridge: 'vmbr0', interface: 'bond0' },
      value: 1,
    }, CORE_NODE_METRIC_CATALOG)).toMatchObject({
      labels: { bridge: 'vmbr0', interface: 'bond0' },
    });
  });

  it('rejects families that are not in the catalog', () => {
    expect(() => parseOpenMetrics(
      'nyabase_node_example_metric{id="a"} 1',
      CORE_NODE_METRIC_CATALOG,
    )).toThrow(OpenMetricsSchemaError);
  });

  it('accepts merged catalogs', () => {
    const catalog = mergeNodeMetricCatalog(
      CORE_NODE_METRIC_CATALOG,
      {
        definitions: { nyabase_node_example_metric: { type: 'gauge', labels: ['id'] } },
        validators: {
          nyabase_node_example_metric: (labels) => ({ ...labels }),
        },
      },
    );
    expect(parseOpenMetrics('nyabase_node_example_metric{id="a"} 1', catalog)).toEqual([
      { name: 'nyabase_node_example_metric', labels: { id: 'a' }, value: 1 },
    ]);
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
