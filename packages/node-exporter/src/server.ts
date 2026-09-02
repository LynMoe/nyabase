import { createServer, type Server as HttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  CORE_NODE_METRIC_CATALOG,
  MAX_NODE_METRICS_BODY_BYTES,
  NODE_METRICS_ENDPOINT_PATH,
  renderOpenMetrics,
  type NodeMetricCatalog,
  type NodeMetricSample,
} from '@nyabase/common';

export interface NodeMetricsCollector {
  collect(): Promise<readonly NodeMetricSample[]>;
}

export interface NodeExporterServerOptions {
  readonly token: string;
  readonly key: string | Buffer;
  readonly cert: string | Buffer;
  readonly collector: NodeMetricsCollector;
  readonly catalog?: NodeMetricCatalog;
  readonly collectionTimeoutMs?: number;
}

const DEFAULT_COLLECTION_TIMEOUT_MS = 1_000;

export function createNodeExporterServer(options: NodeExporterServerOptions): HttpsServer {
  if (
    !options.token
    || options.token.length > 1024
    || /[\u0000-\u001f\u007f\s]/.test(options.token)
  ) {
    throw new Error('A bounded node exporter bearer token is required');
  }
  const handler = createMetricsRequestHandler(options);
  const server = createServer({ key: options.key, cert: options.cert }, handler);
  server.requestTimeout = 2_000;
  server.headersTimeout = 1_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;
  server.on('upgrade', (_request, socket) => socket.destroy());
  return server;
}

export function createMetricsRequestHandler(
  options: Pick<NodeExporterServerOptions, 'token' | 'collector' | 'catalog' | 'collectionTimeoutMs'>,
): (request: IncomingMessage, response: ServerResponse) => void {
  const timeoutMs = options.collectionTimeoutMs ?? DEFAULT_COLLECTION_TIMEOUT_MS;
  const catalog = options.catalog ?? CORE_NODE_METRIC_CATALOG;
  return (request, response) => {
    void handleMetricsRequest(request, response, options.token, options.collector, timeoutMs, catalog);
  };
}

async function handleMetricsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  collector: NodeMetricsCollector,
  timeoutMs: number,
  catalog: NodeMetricCatalog,
): Promise<void> {
  const url = parseRequestUrl(request.url);
  if (!url || url.pathname !== NODE_METRICS_ENDPOINT_PATH || url.search || url.hash) {
    sendText(response, 404, 'not_found');
    return;
  }
  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET');
    sendText(response, 405, 'method_not_allowed');
    return;
  }
  if (!isBearerTokenValid(request.headers.authorization, token)) {
    response.setHeader('www-authenticate', 'Bearer');
    sendText(response, 401, 'unauthorized');
    return;
  }

  try {
    const samples = await withTimeout(collector.collect(), timeoutMs);
    const body = renderOpenMetrics(samples, catalog);
    if (Buffer.byteLength(body, 'utf8') > MAX_NODE_METRICS_BODY_BYTES) {
      sendText(response, 503, 'metrics_unavailable');
      return;
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'content-length': Buffer.byteLength(body, 'utf8'),
    });
    response.end(body);
  } catch {
    // Do not return command output, file paths, tokens, or host details.
    sendText(response, 503, 'metrics_unavailable');
  }
}

function parseRequestUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value, 'https://node-exporter.invalid');
  } catch {
    return null;
  }
}

function isBearerTokenValid(value: string | undefined, expected: string): boolean {
  if (!value || !value.startsWith('Bearer ')) return false;
  const candidate = value.slice('Bearer '.length);
  if (!candidate || candidate.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
  } catch {
    return false;
  }
}

function sendText(response: ServerResponse, status: number, body: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body, 'utf8'),
  });
  response.end(body);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('metrics collection timed out')), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
