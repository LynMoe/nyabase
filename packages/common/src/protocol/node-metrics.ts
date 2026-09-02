import {
  MAX_METRIC_LABEL_KEY_LENGTH,
  MAX_METRIC_LABEL_VALUE_LENGTH,
  NODE_METRIC_NAMES,
} from '../constants.js';
import { canonicalPciAddress } from './rest-schema.js';

const IPV4_PATTERN = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export type NodeMetricFamily = typeof NODE_METRIC_NAMES[number];

export interface NodeMetricSample {
  readonly name: NodeMetricFamily;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

export interface NodeMetricDefinition {
  readonly type: 'gauge' | 'counter';
  readonly labels: readonly string[];
}

export type NodeMetricLabelValidator = (
  labels: Readonly<Record<string, string>>,
) => Record<string, string>;

export interface NodeMetricCatalog {
  readonly definitions: Readonly<Record<string, NodeMetricDefinition>>;
  readonly validators: Readonly<Record<string, NodeMetricLabelValidator>>;
}

export const CORE_LABEL_VALIDATORS: NodeMetricCatalog['validators'] = {};

export function mergeNodeMetricCatalog(
  ...parts: readonly NodeMetricCatalog[]
): NodeMetricCatalog {
  const definitions: Record<string, NodeMetricDefinition> = {};
  const validators: Record<string, NodeMetricLabelValidator> = {};
  for (const part of parts) {
    for (const [name, definition] of Object.entries(part.definitions)) {
      if (Object.prototype.hasOwnProperty.call(definitions, name)) {
        throw new Error(`node metric catalog collision: ${name}`);
      }
      definitions[name] = definition;
    }
    for (const [name, validator] of Object.entries(part.validators)) {
      if (Object.prototype.hasOwnProperty.call(validators, name)) {
        throw new Error(`node metric validator collision: ${name}`);
      }
      validators[name] = validator;
    }
  }
  return { definitions, validators };
}

export const NODE_METRIC_DEFINITIONS: Readonly<Record<NodeMetricFamily, NodeMetricDefinition>> = {
  nyabase_node_cpu_usage_ratio: { type: 'gauge', labels: ['cpu'] },
  nyabase_node_cpu_psi_ratio: { type: 'gauge', labels: ['scope', 'window'] },
  nyabase_node_disk_io_read_bytes_total: { type: 'counter', labels: ['device_id'] },
  nyabase_node_disk_io_write_bytes_total: { type: 'counter', labels: ['device_id'] },
  nyabase_node_disk_io_read_seconds_total: { type: 'counter', labels: ['device_id'] },
  nyabase_node_disk_io_write_seconds_total: { type: 'counter', labels: ['device_id'] },
  nyabase_node_disk_smart_health: { type: 'gauge', labels: ['device_id'] },
  nyabase_node_network_forwarding: { type: 'gauge', labels: ['interface'] },
  nyabase_node_network_rp_filter: { type: 'gauge', labels: ['interface'] },
  nyabase_node_network_fib_rule_present: { type: 'gauge', labels: ['interface'] },
  nyabase_node_network_is_bridge: { type: 'gauge', labels: ['interface'] },
  nyabase_node_network_ipv4_present: { type: 'gauge', labels: ['interface'] },
  nyabase_node_network_bridge_slave: { type: 'gauge', labels: ['bridge', 'interface'] },
  nyabase_node_network_nft_available: { type: 'gauge', labels: [] },
  nyabase_node_network_bridge_filter_present: { type: 'gauge', labels: [] },
  nyabase_node_network_bridge_filter_address: { type: 'gauge', labels: ['address'] },
  nyabase_node_gpu_util_ratio: { type: 'gauge', labels: ['gpu_pci'] },
  nyabase_node_gpu_mem_used_bytes: { type: 'gauge', labels: ['gpu_pci'] },
  nyabase_node_gpu_mem_total_bytes: { type: 'gauge', labels: ['gpu_pci'] },
  nyabase_node_gpu_temperature_celsius: { type: 'gauge', labels: ['gpu_pci'] },
  nyabase_node_gpu_power_watts: { type: 'gauge', labels: ['gpu_pci'] },
  nyabase_node_gpu_smi_index: { type: 'gauge', labels: ['gpu_pci'] },
  nyabase_node_gpu_process_mem_used_bytes: {
    type: 'gauge',
    labels: ['gpu_pci', 'container_id'],
  },
};

const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const CPU_LABEL_PATTERN = /^(?:cpu)?[0-9]+$/;

export class OpenMetricsSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenMetricsSchemaError';
  }
}

export function validateNodeMetricSample(sample: NodeMetricSample): NodeMetricSample {
  if (!METRIC_NAME_PATTERN.test(sample.name) || !isNodeMetricName(sample.name)) {
    throw new OpenMetricsSchemaError('Metric family is not allowlisted');
  }
  if (!Number.isFinite(sample.value)) {
    throw new OpenMetricsSchemaError('Metric value must be finite');
  }

  const definition = NODE_METRIC_DEFINITIONS[sample.name];
  const labels = Object.keys(sample.labels);
  const expectedLabels = [...definition.labels].sort();
  const actualLabels = [...labels].sort();
  if (
    actualLabels.length !== expectedLabels.length
    || actualLabels.some((label, index) => label !== expectedLabels[index])
  ) {
    throw new OpenMetricsSchemaError('Metric labels do not match the allowlist');
  }
  const normalizedLabels: Record<string, string> = {};
  let changed = false;
  for (const [key, value] of Object.entries(sample.labels)) {
    validateLabel(key, value);
    const normalized = validateLabelValue(sample.name, key, value);
    normalizedLabels[key] = normalized;
    changed ||= normalized !== value;
  }
  return changed ? { ...sample, labels: normalizedLabels } : sample;
}

export function parseOpenMetrics(text: string): NodeMetricSample[] {
  const samples: NodeMetricSample[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const match =
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^{}\n]*)\})?\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?:\s+\d+)?$/
        .exec(trimmed);
    if (!match) {
      throw new OpenMetricsSchemaError('OpenMetrics sample syntax is invalid');
    }
    const name = match[1];
    if (!isNodeMetricName(name)) {
      throw new OpenMetricsSchemaError('Metric family is not allowlisted');
    }
    const labels = parseLabels(match[2] ?? '');
    const value = Number(match[3]);
    const sample = validateNodeMetricSample({ name, labels, value });
    const identity = `${name}|${JSON.stringify(
      Object.entries(sample.labels).sort(([left], [right]) => left.localeCompare(right)),
    )}`;
    if (seen.has(identity)) {
      throw new OpenMetricsSchemaError('Duplicate metric sample');
    }
    seen.add(identity);
    samples.push(sample);
  }
  if (samples.length === 0) {
    throw new OpenMetricsSchemaError('OpenMetrics response contains no samples');
  }
  return samples;
}

export function renderOpenMetrics(samples: readonly NodeMetricSample[]): string {
  const lines: string[] = [];
  const emittedTypes = new Set<string>();
  for (const sample of samples) {
    const normalized = validateNodeMetricSample(sample);
    if (!emittedTypes.has(normalized.name)) {
      emittedTypes.add(normalized.name);
      lines.push(`# TYPE ${normalized.name} ${NODE_METRIC_DEFINITIONS[normalized.name].type}`);
    }
    const labels = Object.entries(normalized.labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
      .join(',');
    lines.push(`${normalized.name}{${labels}} ${formatNumber(normalized.value)}`);
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function parseLabels(source: string): Record<string, string> {
  if (source.length === 0) return {};
  const labels: Record<string, string> = {};
  let offset = 0;
  while (offset < source.length) {
    const keyStart = offset;
    while (offset < source.length && /[a-zA-Z0-9_]/.test(source[offset])) offset += 1;
    const key = source.slice(keyStart, offset);
    if (!LABEL_NAME_PATTERN.test(key) || key in labels || source[offset] !== '=') {
      throw new OpenMetricsSchemaError('Metric label syntax is invalid');
    }
    offset += 1;
    if (source[offset] !== '"') {
      throw new OpenMetricsSchemaError('Metric label value must be quoted');
    }
    offset += 1;
    let value = '';
    let closed = false;
    while (offset < source.length) {
      const character = source[offset];
      offset += 1;
      if (character === '"') {
        closed = true;
        break;
      }
      if (character !== '\\') {
        value += character;
        continue;
      }
      if (offset >= source.length) {
        throw new OpenMetricsSchemaError('Metric label escape is incomplete');
      }
      const escaped = source[offset];
      offset += 1;
      value += escaped === 'n' ? '\n' : escaped;
    }
    if (!closed) {
      throw new OpenMetricsSchemaError('Metric label value is unterminated');
    }
    labels[key] = value;
    if (offset === source.length) break;
    if (source[offset] !== ',') {
      throw new OpenMetricsSchemaError('Metric label separator is invalid');
    }
    offset += 1;
    if (offset === source.length) {
      throw new OpenMetricsSchemaError('Metric label separator is trailing');
    }
  }
  return labels;
}

function validateLabel(key: string, value: string): void {
  if (
    !LABEL_NAME_PATTERN.test(key)
    || key.length > MAX_METRIC_LABEL_KEY_LENGTH
    || value.length > MAX_METRIC_LABEL_VALUE_LENGTH
  ) {
    throw new OpenMetricsSchemaError('Metric label is outside the bounded contract');
  }
  if (/(?:token|secret|pid|command)/i.test(key)) {
    throw new OpenMetricsSchemaError('Sensitive or process labels are forbidden');
  }
}

function validateLabelValue(name: NodeMetricFamily, key: string, value: string): string {
  if (key === 'gpu_pci') {
    const normalized = canonicalPciAddress(value);
    if (!normalized) {
      throw new OpenMetricsSchemaError('GPU labels must use PCI addresses');
    }
    return normalized;
  }
  if (key === 'container_id') {
    if (value !== '__unattributed__' && !UUID_PATTERN.test(value)) {
      throw new OpenMetricsSchemaError('Container labels must use nyabase UUIDs');
    }
    return value;
  }
  if (key === 'scope' && value !== 'some' && value !== 'full') {
    throw new OpenMetricsSchemaError('CPU PSI scope is invalid');
  }
  if (key === 'window' && !['10', '60', '300'].includes(value)) {
    throw new OpenMetricsSchemaError('CPU PSI window is invalid');
  }
  if (key === 'cpu' && !CPU_LABEL_PATTERN.test(value)) {
    throw new OpenMetricsSchemaError('CPU labels are invalid');
  }
  if (key === 'address') {
    if (!IPV4_PATTERN.test(value)) {
      throw new OpenMetricsSchemaError('Address labels must be IPv4');
    }
    return value;
  }
  if (
    (key === 'device_id' || key === 'interface' || key === 'bridge')
    && !STABLE_ID_PATTERN.test(value)
  ) {
    throw new OpenMetricsSchemaError('Device and interface labels are invalid');
  }
  if (name.startsWith('nyabase_node_gpu_') && key !== 'gpu_pci' && key !== 'container_id') {
    throw new OpenMetricsSchemaError('GPU labels must use PCI addresses');
  }
  return value;
}

function isNodeMetricName(value: string): value is NodeMetricFamily {
  return (NODE_METRIC_NAMES as readonly string[]).includes(value);
}

function escapeLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('"', '\\"');
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}
