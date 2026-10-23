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
import { checkIncusHttp, checkIncusWebSocket } from './policy.js';
import { bridgeSockets, dialBackendStream } from './stream-bridge.js';

export interface MetricsSource {
  collect(): Promise<readonly import('@nyabase/common').NodeMetricSample[]>;
}

export interface AgentDependencies {
  readonly config: AgentConfig;
  readonly incus: LocalIncus;
  readonly guard: Ipv6Guard;
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
  };
}

async function incusHttp(
  deps: AgentDependencies,
  params: AgentIncusHttpParams,
  signal: AbortSignal,
): Promise<AgentIncusHttpResult> {
  const body = params.body === undefined ? undefined : Buffer.from(params.body, 'base64');
  const verdict = await checkIncusHttp(
    { method: params.method, path: params.path, body },
    (path) => deps.incus.requestJson<Record<string, unknown>>('GET', path).catch(() => undefined),
  );
  if (!verdict.allowed) {
    deps.log(`refused ${params.method} ${params.path.split('?')[0]}: ${verdict.reason}`);
    throw new AgentRequestError('policy_denied', verdict.reason);
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
  const verdict = checkIncusWebSocket(params.path);
  if (!verdict.allowed) throw new AgentRequestError('policy_denied', verdict.reason);
  let incus;
  try {
    incus = await deps.incus.dialWebSocket(params.path, AGENT_STREAM_CONNECT_TIMEOUT_MS);
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

function asRequestError(error: unknown): AgentRequestError {
  if (error instanceof AgentRequestError) return error;
  if (error instanceof LocalIncusError) return new AgentRequestError(error.code, error.message);
  return new AgentRequestError('internal', error instanceof Error ? error.message : String(error));
}
