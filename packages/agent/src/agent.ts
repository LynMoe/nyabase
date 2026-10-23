import { hostname } from 'node:os';
import {
  AGENT_HEARTBEAT_INTERVAL_MS,
  AGENT_PROTOCOL_VERSION,
  AGENT_STREAM_CONNECT_TIMEOUT_MS,
  MAX_AGENT_METRICS_TEXT_BYTES,
  NODE_METRIC_CATALOG,
  renderOpenMetrics,
  type AgentHello,
  type AgentIncusHttpParams,
  type AgentIncusHttpResult,
  type AgentIncusWebSocketParams,
  type AgentMetricsResult,
} from '@nyabase/common';
import { AgentRequestError, type AgentHandlers } from './backend-connection.js';
import { streamUrl, type AgentConfig } from './config.js';
import { LocalIncus, LocalIncusError } from './incus-local.js';
import type { Ipv6Guard } from './ipv6-guard.js';
import type { OperationLedger } from './operation-ledger.js';
import { checkIncusHttp, checkIncusWebSocket, EVENTS_DIAL_PATH, filterIncusEvent } from './policy.js';
import { bridgeSockets, dialBackendStream } from './stream-bridge.js';

export interface MetricsSource {
  collect(): Promise<readonly import('@nyabase/common').NodeMetricSample[]>;
}

export interface AgentDependencies {
  readonly config: AgentConfig;
  readonly incus: LocalIncus;
  readonly guard: Ipv6Guard;
  /** Operations started through the policy; the only ones the Backend can reach. */
  readonly operations: OperationLedger;
  /** config.guestBridges, as the policy reads it. */
  readonly guestBridges: ReadonlySet<string>;
  readonly metrics: MetricsSource;
  readonly credential: () => string;
  readonly version: string;
  readonly log: (message: string) => void;
}

/** The request handlers behind the control connection. */
export function createAgentHandlers(deps: AgentDependencies): AgentHandlers {
  return {
    hello: () => hello(deps),
    incusHttp: (params, signal) => incusHttp(deps, params, signal),
    incusWebSocket: (params, signal, session) => incusWebSocket(deps, params, signal, session),
    collectMetrics: () => collectMetrics(deps),
  };
}

async function hello(deps: AgentDependencies): Promise<AgentHello> {
  const server = await deps.incus.requestJson<{
    environment?: { server_version?: string };
    api_extensions?: string[];
  }>('GET', '/1.0');
  return {
    type: 'hello',
    protocol: AGENT_PROTOCOL_VERSION,
    agentVersion: deps.version,
    hostname: hostname().slice(0, 253) || 'unknown',
    incus: {
      serverVersion: server.environment?.server_version || 'unknown',
      apiExtensions: (server.api_extensions ?? []).slice(0, 2048),
    },
    status: deps.guard.status(),
    guestBridges: [...deps.guestBridges],
  };
}

async function incusHttp(
  deps: AgentDependencies,
  params: AgentIncusHttpParams,
  signal: AbortSignal,
): Promise<AgentIncusHttpResult> {
  const body = params.body === undefined ? undefined : Buffer.from(params.body, 'base64');
  const verdict = await checkIncusHttp({ method: params.method, path: params.path, body }, {
    readCurrent: (path) => deps.incus.requestJson<Record<string, unknown>>('GET', path).catch(() => undefined),
    guestBridges: deps.guestBridges,
    operations: deps.operations,
  });
  if (!verdict.allowed && verdict.notFound) return notFound();
  if (!verdict.allowed) {
    deps.log(`refused ${params.method} ${params.path.split('?')[0]}: ${verdict.reason}`);
    throw new AgentRequestError('policy_denied', verdict.reason);
  }
  // Checked (and re-applied if a firewall reload dropped it) right before the
  // NIC comes up, not trusted from the last periodic check.
  if (verdict.needsIpv6Guard && !await deps.guard.ensure()) {
    deps.log(`refused ${params.method} ${params.path.split('?')[0]}: IPv6 guard is not in place`);
    throw new AgentRequestError(
      'ipv6_guard_missing',
      `the IPv6 guard (nft table bridge nyabase_guard) is not in place: ${deps.guard.error ?? 'unknown error'}`,
    );
  }
  try {
    const response = await deps.incus.request({
      method: params.method,
      path: params.path,
      headers: params.headers,
      // Never the raw bytes: Incus would decode them differently from the policy.
      body: verdict.body,
      timeoutMs: params.timeoutMs,
      signal,
    });
    deps.operations.recordResponse(response.status, response.body);
    return { status: response.status, headers: response.headers, body: response.body.toString('base64') };
  } catch (error) {
    throw asRequestError(error);
  }
}

async function incusWebSocket(
  deps: AgentDependencies,
  params: AgentIncusWebSocketParams,
  signal: AbortSignal,
  session: AbortSignal,
): Promise<void> {
  const verdict = checkIncusWebSocket(params.path, deps.operations);
  if (!verdict.allowed) throw new AgentRequestError('policy_denied', verdict.reason);
  const events = verdict.kind === 'events';
  let incus;
  try {
    incus = await deps.incus.dialWebSocket(events ? EVENTS_DIAL_PATH : params.path, AGENT_STREAM_CONNECT_TIMEOUT_MS);
  } catch (error) {
    throw asRequestError(error);
  }
  if (signal.aborted || session.aborted) {
    incus.socket.terminate();
    throw new AgentRequestError('cancelled', 'stream request was cancelled');
  }
  try {
    const backendSocket = await dialBackendStream(
      streamUrl(deps.config, params.streamId),
      deps.credential(),
      deps.config.backendCa,
    );
    // Bound to the control session and heartbeated: a partition that the
    // Backend already noticed must not leave an exec session running here.
    bridgeSockets(incus.socket, backendSocket, incus.release(), {
      session,
      heartbeatMs: AGENT_HEARTBEAT_INTERVAL_MS,
      // The host's other workloads (and who drove them) are not the Backend's business.
      ...(events ? { filterLeft: filterIncusEvent } : {}),
    });
  } catch (error) {
    incus.socket.terminate();
    throw new AgentRequestError('internal', error instanceof Error ? error.message : String(error));
  }
}

async function collectMetrics(deps: AgentDependencies): Promise<AgentMetricsResult> {
  const samples = [...await deps.metrics.collect(), ...deps.guard.samples()];
  const text = renderOpenMetrics(samples, NODE_METRIC_CATALOG);
  if (Buffer.byteLength(text, 'utf8') > MAX_AGENT_METRICS_TEXT_BYTES) {
    throw new AgentRequestError('too_large', 'metrics exceed the transfer limit');
  }
  return { text };
}

/** What Incus answers for an operation it does not know. */
function notFound(): AgentIncusHttpResult {
  const body = JSON.stringify({ type: 'error', status: '', status_code: 0, operation: '', error_code: 404, error: 'Operation not found', metadata: null });
  return { status: 404, headers: { 'content-type': 'application/json' }, body: Buffer.from(body).toString('base64') };
}

function asRequestError(error: unknown): AgentRequestError {
  if (error instanceof AgentRequestError) return error;
  if (error instanceof LocalIncusError) return new AgentRequestError(error.code, error.message);
  return new AgentRequestError('internal', error instanceof Error ? error.message : String(error));
}
