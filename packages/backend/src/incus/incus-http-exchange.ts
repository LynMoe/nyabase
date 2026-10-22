import type { IncomingHttpHeaders } from 'node:http';
import { IncusError, mapIncusApiFailure } from './incus-errors.js';
import type { IncusEnvelope, IncusFileResponse, IncusResponse } from './incus-client-types.js';

export function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function parseNumberHeader(headers: IncomingHttpHeaders, name: string): number | undefined {
  const value = headerValue(headers, name);
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

export type ExchangeResult =
  | { readonly kind: 'json'; readonly value: IncusResponse<unknown> }
  | {
      readonly kind: 'raw';
      readonly value: Omit<IncusFileResponse, 'uid' | 'gid' | 'mode' | 'type' | 'modified'>;
    };

/** One Incus HTTP response as it came back through the agent tunnel. */
export interface ExchangeResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** Turn a complete response into a result, or throw the matching Incus error. */
export function parseResponse(
  response: ExchangeResponse,
  responseType: 'json' | 'raw',
  requestPath: string,
): ExchangeResult {
  const { status, headers, body: payload } = response;
  const etag = headerValue(headers, 'etag');
  if (responseType === 'raw' && status >= 200 && status < 300) {
    return { kind: 'raw', value: { status, headers, etag, body: payload } };
  }

  let parsed: unknown;
  if (payload.byteLength > 0) {
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch {
      if (status >= 400) {
        throw mapIncusApiFailure({
          status,
          errorText: payload.toString('utf8').slice(0, 256),
          details: { path: requestPath },
        });
      }
      throw new IncusError('INCUS_JSON_ERROR', 'managed_failure', { status });
    }
  }

  const envelope =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as IncusEnvelope<unknown>)
      : undefined;
  const apiStatus =
    typeof envelope?.status_code === 'number' && envelope.status_code > 0
      ? envelope.status_code
      : typeof envelope?.error_code === 'number' && envelope.error_code > 0
        ? envelope.error_code
        : status;
  if (status < 200 || status >= 300 || envelope?.type === 'error') {
    throw mapIncusApiFailure({
      status: apiStatus,
      apiErrorCode: envelope?.error_code,
      errorText: envelope?.error,
      operationId: envelope?.operation,
      details: { path: requestPath },
    });
  }
  if (!envelope || typeof envelope !== 'object') {
    throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', { status });
  }
  return {
    kind: 'json',
    value: {
      status,
      headers,
      etag,
      envelope,
      metadata: envelope.metadata,
    },
  };
}
