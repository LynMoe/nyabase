import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { IncusError, normalizeCertificateFingerprint } from './incus-errors.js';
import type { IncusEnvelope, IncusExecFd, IncusTimeouts } from './incus-client-types.js';

export const DEFAULT_TIMEOUTS: IncusTimeouts = {
  connectMs: 5_000,
  headersMs: 10_000,
  bodyMs: 10_000,
  totalMs: 30_000,
};

export const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;

export function boundedTimeout(value: number | undefined, fallback: number): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
    throw new IncusError('INCUS_TIMEOUT', 'managed_failure', { phase: 'configuration' });
  }
  return timeout;
}

export function normalizeTimeouts(input?: Partial<IncusTimeouts>): IncusTimeouts {
  return {
    connectMs: boundedTimeout(input?.connectMs, DEFAULT_TIMEOUTS.connectMs),
    headersMs: boundedTimeout(input?.headersMs, DEFAULT_TIMEOUTS.headersMs),
    bodyMs: boundedTimeout(input?.bodyMs, DEFAULT_TIMEOUTS.bodyMs),
    totalMs: boundedTimeout(input?.totalMs, DEFAULT_TIMEOUTS.totalMs),
  };
}

export function assertHeaderValue(value: string, name: string): void {
  if (/[\r\n]/.test(value)) {
    throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', { reason: name });
  }
}

export function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
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

export function cloneRecord<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneRecord(item)) as T;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = cloneRecord(child);
  }
  return copy as T;
}

export function parseNumberHeader(headers: IncomingHttpHeaders, name: string): number | undefined {
  const value = headerValue(headers, name);
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

/**
 * Incus/LXD historically return file modes as zero-padded octal (e.g. "0600").
 * Some responses use decimal strings (e.g. "384"). Accept both.
 */
export function parseModeHeader(headers: IncomingHttpHeaders, name: string): number | undefined {
  const value = headerValue(headers, name);
  if (!value) {
    return undefined;
  }
  if (/^0[0-7]+$/.test(value)) {
    const number = Number.parseInt(value, 8);
    return Number.isSafeInteger(number) ? number : undefined;
  }
  if (/^\d+$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : undefined;
  }
  return undefined;
}

/** Encode file modes the way live Incus expects (zero-padded octal). */
export function encodeModeHeader(mode: number): string {
  if (!Number.isSafeInteger(mode) || mode < 0) {
    throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', { reason: 'invalid_file_mode' });
  }
  return `0${mode.toString(8)}`;
}

export function mutableCa(
  ca: string | Buffer | readonly (string | Buffer)[] | undefined,
): string | Buffer | (string | Buffer)[] | undefined {
  if (Array.isArray(ca)) {
    return Array.from(ca) as (string | Buffer)[];
  }
  return ca as string | Buffer | undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function encodeCertificateForPost(certificatePem: string): string {
  const match = /^-----BEGIN CERTIFICATE-----\s*([\s\S]*?)\s*-----END CERTIFICATE-----\s*$/.exec(
    certificatePem.trim(),
  );
  const encoded = match?.[1]?.replace(/\s/g, '');
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', {
      reason: 'invalid_certificate_pem',
    });
  }
  const der = Buffer.from(encoded, 'base64');
  if (der.byteLength === 0) {
    throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', {
      reason: 'invalid_certificate_pem',
    });
  }
  return der.toString('base64');
}

export function operationIdFromEnvelope(envelope: IncusEnvelope<unknown>): string {
  const operation = envelope.operation;
  if (typeof operation !== 'string' || operation.length === 0) {
    throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
      reason: 'missing_operation',
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(operation, 'https://incus.invalid');
  } catch {
    throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
      reason: 'invalid_operation',
    });
  }
  if (
    parsed.origin !== 'https://incus.invalid' ||
    parsed.search ||
    parsed.hash ||
    !/^\/1\.0\/operations\/[^/]+$/.test(parsed.pathname)
  ) {
    throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
      reason: 'invalid_operation',
    });
  }
  const encodedId = parsed.pathname.slice('/1.0/operations/'.length);
  let id: string;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
      reason: 'invalid_operation',
    });
  }
  if (!id || /[\u0000-\u001f\u007f/\\]/.test(id)) {
    throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
      reason: 'invalid_operation',
    });
  }
  return id;
}

export function extractExecFileDescriptors(
  metadata: unknown,
): Readonly<Partial<Record<IncusExecFd, string>>> {
  const candidates: unknown[] = [metadata];
  if (isRecord(metadata)) {
    candidates.push(metadata.metadata);
  }
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.fds)) {
      continue;
    }
    const fds: Partial<Record<IncusExecFd, string>> = {};
    for (const channel of ['0', '1', '2', 'control'] as const) {
      const secret = candidate.fds[channel];
      if (
        typeof secret === 'string' &&
        secret.length > 0 &&
        !/[\u0000-\u001f\u007f]/.test(secret)
      ) {
        fds[channel] = secret;
      }
    }
    return fds;
  }
  throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
    reason: 'missing_exec_fds',
  });
}

export function isTimeoutError(error: unknown): error is IncusError {
  return error instanceof IncusError && error.code === 'INCUS_TIMEOUT';
}

/**
 * Operation wait 404 means Incus dropped the operation record, not that the
 * mutated resource is absent. Callers must re-read the actual object instead of
 * mapping this to INCUS_NOT_FOUND for the instance/volume/image.
 */
export function isOperationWaitNotFound(error: unknown): error is IncusError {
  if (!(error instanceof IncusError) || error.code !== 'INCUS_NOT_FOUND') {
    return false;
  }
  const path = error.details.path;
  return typeof path === 'string' && /^\/1\.0\/operations\/[^/]+\/wait(?:\?|$)/.test(path);
}

/**
 * A mutation timeout or operation-wait 404 leaves the physical outcome unknown.
 * Callers must read the authoritative state once before deciding whether another
 * mutation is needed. A failed follow-up read rethrows the original wait error
 * so wait-404 is never converted into instance INCUS_NOT_FOUND by itself.
 */
export async function readAfterTimeout<T>(
  mutate: () => Promise<T>,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await mutate();
  } catch (error) {
    if (!isTimeoutError(error) && !isOperationWaitNotFound(error)) {
      throw error;
    }
    try {
      return await read();
    } catch {
      throw error;
    }
  }
}

export function leafCertificateFingerprint(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function assertLeafCertificateFingerprint(raw: Buffer, expected: string): string {
  const actual = leafCertificateFingerprint(raw);
  if (actual !== normalizeCertificateFingerprint(expected)) {
    throw new IncusError('TLS_PIN_MISMATCH', 'managed_failure');
  }
  return actual;
}
