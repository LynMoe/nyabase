import { Injectable } from '@nestjs/common';
import {
  NODE_METRICS_PARSE_TIMEOUT_MS,
  NODE_METRICS_REQUEST_TIMEOUT_MS,
  NODE_METRIC_CATALOG,
  parseOpenMetrics,
  type NodeMetricCatalog,
  type NodeMetricSample,
} from '@nyabase/common';
import { AgentRegistry } from '../incus/agent-registry.service.js';
import { IncusError } from '../incus/index.js';

export type NodeMetricsPullFailureCode =
  | 'NODE_METRICS_UNREACHABLE'
  | 'NODE_METRICS_INVALID_RESPONSE';

export class NodeMetricsPullError extends Error {
  readonly code: NodeMetricsPullFailureCode;

  constructor(code: NodeMetricsPullFailureCode, message: string) {
    super(message);
    this.name = 'NodeMetricsPullError';
    this.code = code;
  }
}

export interface NodeMetricsPullReport {
  readonly [key: string]: unknown;
  readonly source: 'agent';
  readonly contentType: string;
  readonly sampleCount: number;
  readonly samples: readonly NodeMetricSample[];
  readonly metrics: Readonly<Record<string, number>>;
}

/** Host and container metrics, collected by the server's agent on request over its control socket. */
@Injectable()
export class AgentNodeMetricsPullAdapter {
  private readonly catalog: NodeMetricCatalog = NODE_METRIC_CATALOG;

  constructor(private readonly agents: AgentRegistry) {}

  async pull(
    serverId: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly status: 'online' | 'unreachable' | 'unknown';
    readonly report: NodeMetricsPullReport;
  }> {
    let text: string;
    try {
      text = await this.agents.require(serverId).collectMetrics(NODE_METRICS_REQUEST_TIMEOUT_MS, signal);
    } catch (error) {
      throw new NodeMetricsPullError(
        'NODE_METRICS_UNREACHABLE',
        error instanceof IncusError ? error.code : 'The server agent did not return metrics',
      );
    }
    const samples = parseMetrics(text, this.catalog);
    return {
      status: 'online',
      report: {
        source: 'agent',
        contentType: 'text/plain',
        sampleCount: samples.length,
        samples,
        metrics: firstMetricValues(samples),
      },
    };
  }
}

function parseMetrics(body: string, catalog: NodeMetricCatalog): NodeMetricSample[] {
  try {
    const startedAt = Date.now();
    const samples = parseOpenMetrics(body, catalog);
    if (Date.now() - startedAt > NODE_METRICS_PARSE_TIMEOUT_MS) {
      throw new Error('OpenMetrics parsing exceeded its time budget');
    }
    return samples;
  } catch {
    throw new NodeMetricsPullError(
      'NODE_METRICS_INVALID_RESPONSE',
      'Node metrics response failed the allowlisted OpenMetrics schema',
    );
  }
}

function firstMetricValues(samples: readonly NodeMetricSample[]): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const sample of samples) {
    if (metrics[sample.name] === undefined) metrics[sample.name] = sample.value;
  }
  return metrics;
}
