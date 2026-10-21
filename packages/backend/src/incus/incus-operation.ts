import type {
  IncusClientPort,
  IncusEnvelope,
  IncusOperationWaitOptions,
  IncusResponse,
  IncusRequestOptions,
  IncusSchema,
} from './incus-client-types.js';
import {
  IncusError,
  mapIncusOperationFailure,
  type IncusErrorDetailValue,
  type IncusErrorDetails,
} from './incus-errors.js';
import { isRecord } from '../platform/domain-utils.js';

export interface IncusOperationWaitResult {
  readonly kind: 'completed';
  readonly operationId: string;
  readonly status?: string;
  readonly statusCode?: number;
  readonly error?: string;
  readonly errorCode?: number;
  readonly metadata: IncusSchema<'Operation'>;
  readonly response: IncusResponse<IncusSchema<'Operation'>>;
}

export interface IncusSynchronousResult<T> {
  readonly kind: 'synchronous';
  readonly response: IncusResponse<T>;
}

export type IncusCompletedResult<T> = IncusSynchronousResult<T> | IncusOperationWaitResult;

function boundedText(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maxLength) : undefined;
}

function operationErrorText(operation: IncusSchema<'Operation'>): string | undefined {
  if (operation.err !== undefined) {
    return boundedText(operation.err, 512);
  }
  const raw = operation as unknown as Record<string, unknown>;
  return boundedText(raw.error, 512);
}

function operationErrorCode(operation: IncusSchema<'Operation'>): number | undefined {
  const raw = operation as unknown as Record<string, unknown>;
  return typeof raw.error_code === 'number' && Number.isSafeInteger(raw.error_code)
    ? raw.error_code
    : undefined;
}

function toDetailValue(value: unknown): IncusErrorDetailValue | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const values: IncusErrorDetailValue[] = [];
    for (const item of value) {
      const converted = toDetailValue(item);
      if (converted === undefined) return undefined;
      values.push(converted);
    }
    return values;
  }
  if (isRecord(value)) {
    const record: Record<string, IncusErrorDetailValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = toDetailValue(item);
      if (converted === undefined) return undefined;
      record[key] = converted;
    }
    return record;
  }
  return undefined;
}

function operationDetails(operation: IncusSchema<'Operation'>): IncusErrorDetails {
  const details: Record<string, IncusErrorDetailValue> = {};
  const metadata = toDetailValue(operation.metadata);
  if (metadata !== undefined) {
    details.metadata = metadata;
  }
  return details;
}

function operationIsSuccessful(
  operation: IncusSchema<'Operation'>,
  envelope: IncusEnvelope<unknown>,
): boolean {
  const statusCode = operation.status_code ?? envelope.status_code;
  const error = operationErrorText(operation) ?? boundedText(envelope.error, 512);
  if (error) return false;
  if (typeof statusCode === 'number' && statusCode >= 400) return false;
  if (typeof envelope.error_code === 'number' && envelope.error_code >= 400) return false;
  if (typeof operation.status === 'string') {
    const normalized = operation.status.trim().toLowerCase();
    if (normalized === 'failure' || normalized === 'error' || normalized === 'failed') {
      return false;
    }
  }
  return true;
}

export function isAsyncIncusResponse<T>(
  response: IncusResponse<T>,
): response is IncusResponse<T> & {
  readonly envelope: IncusEnvelope<T> & { readonly operation: string };
} {
  const operation = response.envelope.operation;
  return (
    response.status === 202 ||
    response.envelope.type === 'async' ||
    (typeof operation === 'string' && operation.length > 0)
  );
}

export function operationIdFromResponse(response: IncusResponse<unknown>): string {
  const operation = response.envelope.operation;
  if (typeof operation !== 'string' || operation.length === 0) {
    throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
      reason: 'missing_operation',
    });
  }
  const match = /^\/1\.0\/operations\/([^/?#]+)$/.exec(operation);
  if (!match) {
    throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
      reason: 'invalid_operation',
    });
  }
  const operationId = decodeOperationId(match[1]);
  if (!operationId) {
    throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
      reason: 'invalid_operation',
    });
  }
  return operationId;
}

function decodeOperationId(encoded: string): string | undefined {
  try {
    const decoded = decodeURIComponent(encoded);
    if (!decoded || /[\u0000-\u001f\u007f/\\]/.test(decoded)) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

export async function waitForIncusOperation(
  client: Pick<IncusClientPort, 'getOperationWait'>,
  response: IncusResponse<unknown>,
  options: IncusOperationWaitOptions = {},
): Promise<IncusOperationWaitResult> {
  const operationId = operationIdFromResponse(response);
  const waited = await client.getOperationWait(operationId, options);
  const operation = waited.metadata;
  const errorText = operation
    ? (operationErrorText(operation) ?? boundedText(waited.envelope.error, 512))
    : boundedText(waited.envelope.error, 512);
  const statusCode = operation?.status_code ?? waited.envelope.status_code;
  const errorCode = operation
    ? (operationErrorCode(operation) ?? waited.envelope.error_code)
    : waited.envelope.error_code;
  // Incus `/operations/{id}/wait` reports completed-but-failed operations as
  // `type=error` with `error_code=500` and null metadata — including permanent
  // configuration errors such as "Invalid CPU limit syntax". Prefer the
  // operation status_code when present; otherwise treat wait-envelope failures
  // with an error string as operation failures (400), not transport 500 retries.
  const failureStatusCode = (() => {
    if (typeof operation?.status_code === 'number' && operation.status_code >= 400) {
      return operation.status_code;
    }
    if (
      waited.envelope.type === 'error'
      && errorText
      && (typeof waited.envelope.status_code !== 'number' || waited.envelope.status_code < 400)
    ) {
      return 400;
    }
    if (typeof statusCode === 'number' && statusCode >= 400) {
      return statusCode;
    }
    if (typeof errorCode === 'number' && errorCode >= 400) {
      return errorCode;
    }
    return statusCode;
  })();
  if (
    !operation ||
    typeof operation !== 'object' ||
    !operationIsSuccessful(operation, waited.envelope)
  ) {
    throw mapIncusOperationFailure({
      operationId,
      statusCode: failureStatusCode,
      errorCode,
      status: boundedText(operation?.status, 128),
      errorText,
      details: operation ? operationDetails(operation) : { reason: 'missing_operation_metadata' },
    });
  }
  return {
    kind: 'completed',
    operationId,
    status: operation.status,
    statusCode,
    error: errorText,
    errorCode,
    metadata: operation,
    response: waited,
  };
}

export async function requestAndWait<T>(
  client: Pick<IncusClientPort, 'getOperationWait'>,
  request: (options?: Pick<IncusRequestOptions, 'signal'>) => Promise<IncusResponse<T>>,
  options: IncusOperationWaitOptions = {},
): Promise<IncusCompletedResult<T>> {
  const response = await request({ signal: options.signal });
  if (!isAsyncIncusResponse(response)) {
    return { kind: 'synchronous', response };
  }
  return waitForIncusOperation(client, response as IncusResponse<unknown>, options);
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

function isTimeoutError(error: unknown): error is IncusError {
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
