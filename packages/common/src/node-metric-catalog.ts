import { GPU_NODE_METRIC_CATALOG } from './gpu/metrics.js';
import { CORE_NODE_METRIC_CATALOG, mergeNodeMetricCatalog } from './protocol/node-metrics.js';

/** Every metric family the platform accepts from node-exporter: core plus GPU. */
export const NODE_METRIC_CATALOG = mergeNodeMetricCatalog(
  CORE_NODE_METRIC_CATALOG,
  GPU_NODE_METRIC_CATALOG,
);
