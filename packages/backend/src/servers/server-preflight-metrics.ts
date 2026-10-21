import type { NodeMetricSample } from '@nyabase/common';
import { sql } from 'kysely';
import { IncusError } from '../incus/index.js';
import type { AuthenticatedNodeMetricsPullAdapter } from '../metrics/node-metrics-pull.adapter.js';
import type { ServerPreflightStore } from './server-preflight.store.js';
import { ServerRevisionChangedError, type ServerRow } from './server-preflight-support.js';

export interface NodeMetricsPull {
  readonly status: 'online' | 'unreachable' | 'unknown';
  readonly report?: Record<string, unknown> & {
    readonly samples?: readonly NodeMetricSample[];
  };
}

/** Pull the server's node-exporter metrics and record the pull outcome on the server. */
export async function pullNodeMetrics(
  store: ServerPreflightStore,
  adapter: AuthenticatedNodeMetricsPullAdapter,
  server: ServerRow,
  signal: AbortSignal,
  expectedRevision?: number,
): Promise<NodeMetricsPull> {
  const project = async (values: Record<string, unknown>): Promise<void> => {
    if (!(await store.projectServer(server.id, expectedRevision, values))) {
      throw new ServerRevisionChangedError();
    }
  };
  if (!server.node_metrics_endpoint || !server.node_metrics_token_ciphertext) {
    await project({
      node_metrics_status: 'unconfigured',
      node_metrics_last_error: 'Node metrics endpoint or token is not configured',
    });
    throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
      reason: 'node_metrics_pull_unconfigured',
    });
  }
  try {
    const result = await adapter.pull(
      server.id,
      server.node_metrics_endpoint,
      server.node_metrics_token_ciphertext,
      signal,
    );
    if (result.status !== 'online') {
      await project({
        node_metrics_status: result.status,
        node_metrics_outage_since: sql<Date>`coalesce(node_metrics_outage_since, clock_timestamp())`,
        node_metrics_last_error: `Node metrics status: ${result.status}`,
      });
      throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
        reason: 'node_metrics_pull_not_online',
        status: result.status,
      });
    }
    await project({
      node_metrics_status: 'online',
      node_metrics_last_success_at: sql<Date>`clock_timestamp()`,
      node_metrics_outage_since: null,
      node_metrics_last_error: null,
    });
    return result;
  } catch (error) {
    if (error instanceof ServerRevisionChangedError) throw error;
    if (error instanceof IncusError) throw error;
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'NODE_METRICS_PULL_FAILED';
    await project({
      node_metrics_status: 'unknown',
      node_metrics_outage_since: sql<Date>`coalesce(node_metrics_outage_since, clock_timestamp())`,
      node_metrics_last_error: `Node metrics pull failed: ${code}`,
    });
    throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
      reason: 'node_metrics_pull_failed',
      code,
    });
  }
}

/** The second pull, after the probe exists, which must prove nftables state. */
export async function pullNodeMetricsAfterProbe(
  adapter: AuthenticatedNodeMetricsPullAdapter,
  server: ServerRow,
  signal: AbortSignal,
): Promise<NodeMetricsPull> {
  if (!server.node_metrics_endpoint || !server.node_metrics_token_ciphertext) {
    throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
      reason: 'preflight_nft_unavailable',
    });
  }
  try {
    const result = await adapter.pull(
      server.id,
      server.node_metrics_endpoint,
      server.node_metrics_token_ciphertext,
      signal,
    );
    if (result.status !== 'online') {
      throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
        reason: 'preflight_nft_unavailable',
        status: result.status,
      });
    }
    return result;
  } catch (error) {
    if (error instanceof IncusError) throw error;
    throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
      reason: 'preflight_nft_unavailable',
    });
  }
}
