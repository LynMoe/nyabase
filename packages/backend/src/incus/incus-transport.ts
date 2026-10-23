import type { IncomingHttpHeaders } from 'node:http';
import { MAX_AGENT_INCUS_BODY_BYTES, MAX_AGENT_INCUS_REQUEST_BODY_BYTES } from '@nyabase/common';
import { IncusError } from './incus-errors.js';
import type {
  IncusClientOptions,
  IncusFileResponse,
  IncusHttpMethod,
  IncusRequestOptions,
  IncusResponse,
  IncusTimeouts,
  IncusTunnel,
  IncusWebSocketLike,
} from './incus-client-types.js';
import { parseResponse, type ExchangeResult } from './incus-http-exchange.js';

const DEFAULT_TIMEOUTS: IncusTimeouts = {
  connectMs: 5_000,
  headersMs: 10_000,
  bodyMs: 10_000,
  totalMs: 30_000,
};

const MAX_TIMEOUT_MS = 600_000;

export function boundedTimeout(value: number | undefined, fallback: number): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
    throw new IncusError('INCUS_TIMEOUT', 'managed_failure', { phase: 'configuration' });
  }
  return timeout;
}

function normalizeTimeouts(input?: Partial<IncusTimeouts>): IncusTimeouts {
  return {
    connectMs: boundedTimeout(input?.connectMs, DEFAULT_TIMEOUTS.connectMs),
    headersMs: boundedTimeout(input?.headersMs, DEFAULT_TIMEOUTS.headersMs),
    bodyMs: boundedTimeout(input?.bodyMs, DEFAULT_TIMEOUTS.bodyMs),
    totalMs: boundedTimeout(input?.totalMs, DEFAULT_TIMEOUTS.totalMs),
  };
}

function assertHeaderValue(value: string, name: string): void {
  if (/[\r\n]/.test(value)) {
    throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', { reason: name });
  }
}

export function encodeSegment(value: string, label: string): string {
  if (!value || value === '.' || value === '..' || /[\u0000-\u001f\u007f/\\]/.test(value)) {
    throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', { reason: label });
  }
  return encodeURIComponent(value);
}

/** Image alias names may contain `/` (e.g. ubuntu/24.04). Do not use encodeSegment. */
export function encodeImageAliasName(value: string): string {
  if (
    !value
    || value === '.'
    || value === '..'
    || value.includes('//')
    || value.startsWith('/')
    || value.endsWith('/')
    || /[\u0000-\u001f\u007f\\]/.test(value)
  ) {
    throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', { reason: 'image_alias' });
  }
  return encodeURIComponent(value);
}

export function appendQuery(
  path: string,
  values: Readonly<Record<string, string | number | undefined>>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const queryString = query.toString();
  return queryString ? `${path}${path.includes('?') ? '&' : '?'}${queryString}` : path;
}

function assertApiPath(path: string): void {
  const rawPath = path.split(/[?#]/, 1)[0] ?? '';
  if (
    !path.startsWith('/1.0')
    || path.startsWith('//')
    || /[\u0000-\u001f\u007f#]/.test(path)
    || /%2e|%5c/i.test(rawPath)
    || (rawPath !== '/1.0' && !rawPath.startsWith('/1.0/'))
  ) {
    throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', { reason: 'path' });
  }
}

/**
 * Request framing shared by every Incus endpoint: path checks, body encoding
 * and response parsing. The bytes travel through the server's host agent.
 */
export class IncusTransport {
  readonly timeouts: IncusTimeouts;
  readonly operationWaitTimeoutMs: number;
  readonly maxBodyBytes: number;
  private readonly tunnel: IncusTunnel;

  constructor(options: IncusClientOptions) {
    this.tunnel = options.tunnel;
    this.timeouts = normalizeTimeouts(options.timeouts);
    this.operationWaitTimeoutMs = boundedTimeout(
      options.operationWaitTimeoutMs,
      DEFAULT_TIMEOUTS.totalMs,
    );
    this.maxBodyBytes = options.maxBodyBytes ?? MAX_AGENT_INCUS_BODY_BYTES;
    if (
      !Number.isSafeInteger(this.maxBodyBytes)
      || this.maxBodyBytes <= 0
      || this.maxBodyBytes > MAX_AGENT_INCUS_BODY_BYTES
    ) {
      throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
        reason: 'body_limit',
      });
    }
  }

  async requestJson<T>(
    method: IncusHttpMethod,
    path: string,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<T>> {
    const response = await this.executeRequest(method, path, options);
    if (response.kind !== 'json') {
      throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
        reason: 'expected_json',
      });
    }
    return response.value as IncusResponse<T>;
  }

  async requestRaw(
    method: IncusHttpMethod,
    path: string,
    options: IncusRequestOptions = {},
  ): Promise<IncusFileResponse> {
    const response = await this.executeRequest(method, path, {
      ...options,
      responseType: 'raw',
    });
    if (response.kind !== 'raw') {
      throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
        reason: 'expected_raw',
      });
    }
    return response.value;
  }

  dialWebSocket(path: string, signal?: AbortSignal): Promise<IncusWebSocketLike> {
    assertApiPath(path);
    return this.tunnel.openWebSocket(path, signal);
  }

  /** Execute one request through the agent and return the parsed JSON or raw response. */
  async executeRequest(
    method: IncusHttpMethod,
    path: string,
    options: IncusRequestOptions,
  ): Promise<ExchangeResult> {
    assertApiPath(path);
    const headers: Record<string, string> = { ...options.headers };
    for (const [name, value] of Object.entries(headers)) {
      assertHeaderValue(value, name);
    }
    if (options.ifMatch !== undefined) {
      assertHeaderValue(options.ifMatch, 'if-match');
      headers['If-Match'] = options.ifMatch;
    }
    const body = this.encodeBody(options, headers);
    const timeoutMs = boundedTimeout(options.timeoutMs, this.timeouts.totalMs);
    const response = await this.tunnel.request({
      method,
      path,
      headers,
      body,
      timeoutMs,
      signal: options.signal,
    });
    if (response.body.byteLength > this.maxBodyBytes) {
      throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', { reason: 'body_too_large' });
    }
    return parseResponse(
      { status: response.status, headers: response.headers as IncomingHttpHeaders, body: response.body },
      options.responseType ?? 'json',
      path,
    );
  }

  /** The serialized request body, with content headers set; refuses oversized or unserializable bodies. */
  private encodeBody(
    options: IncusRequestOptions,
    headers: Record<string, string>,
  ): Buffer | undefined {
    if (options.body === undefined) return undefined;
    let body: Buffer;
    if (Buffer.isBuffer(options.body)) {
      body = options.body;
    } else {
      try {
        body = Buffer.from(JSON.stringify(options.body));
      } catch {
        throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', {
          reason: 'body_not_serializable',
        });
      }
      headers['content-type'] ??= 'application/json';
    }
    if (body.byteLength > Math.min(this.maxBodyBytes, MAX_AGENT_INCUS_REQUEST_BODY_BYTES)) {
      throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', {
        reason: 'request_body_too_large',
      });
    }
    return body;
  }
}
