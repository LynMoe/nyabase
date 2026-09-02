export type IncusErrorDisposition = 'retry' | 'managed_failure';

export type IncusFailureCode =
  | 'INCUS_HTTP_ERROR'
  | 'INCUS_API_ERROR'
  | 'INCUS_INVALID_RESPONSE'
  | 'INCUS_JSON_ERROR'
  | 'INCUS_NOT_FOUND'
  | 'INCUS_UNAUTHORIZED'
  | 'INCUS_FORBIDDEN'
  | 'INCUS_BAD_REQUEST'
  | 'ETAG_CONFLICT'
  | 'INSTANCE_BUSY'
  | 'OPERATION_FAILED'
  | 'SERVER_UNREACHABLE'
  | 'INCUS_TIMEOUT'
  | 'TLS_ERROR'
  | 'TLS_PIN_MISMATCH'
  | 'INVALID_ENDPOINT'
  | 'MISSING_MANAGED_NETWORK_ADDRESS'
  | 'INVALID_MANAGED_NETWORK_TYPE'
  | 'INVALID_MANAGED_FILTER_IDENTITY'
  | 'INVALID_INSTANCE_SPEC'
  | 'INVALID_INSTANCE_ID'
  | 'INVALID_IMAGE_FINGERPRINT'
  | 'INVALID_VOLUME_NAME'
  | 'INVALID_ATTACHMENT_PATH'
  | 'IMAGE_NOT_AVAILABLE'
  | 'VOLUME_SECURITY_SHIFTED_MISMATCH'
  | 'VOLUME_SHRINK_BELOW_USAGE'
  | 'ROOT_SHRINK_BELOW_USAGE'
  | 'VOLUME_SHRINK_REQUIRES_DETACH'
  | 'VOLUME_SHRINK_REQUIRES_STOP'
  | 'VOLUME_RESIZE_UNSUPPORTED'
  | 'ROOT_SHRINK_REQUIRES_STOP'
  | 'ROOT_QUOTA_PENDING'
  | 'SSH_DAEMON_PENDING'
  | 'GUEST_NOT_READY'
  | 'RESTART_BASELINE_MISSING'
  | 'RESTART_PROOF_MISSING'
  | 'PREFLIGHT_IDENTITY_MISMATCH'
  | 'PREFLIGHT_CLEANUP_FAILED'
  | 'PREFLIGHT_FAILED'
  | 'TRUST_TOKEN_MISSING'
  | 'TRUST_TOKEN_UNAVAILABLE'
  | 'TRUST_TOKEN_REJECTED'
  | 'MISSING_STORAGE_POOL'
  | 'RESOURCE_NEEDS_ATTENTION'
  | 'VOLUME_PLACEMENT_PENDING'
  | 'VOLUME_CATALOG_ADOPT_PENDING';

export type IncusErrorDetailValue =
  | string
  | number
  | boolean
  | null
  | readonly IncusErrorDetailValue[]
  | { readonly [key: string]: IncusErrorDetailValue };

export type IncusErrorDetails = Readonly<Record<string, IncusErrorDetailValue>>;

const FAILURE_MESSAGES: Record<IncusFailureCode, string> = {
  INCUS_HTTP_ERROR: 'Incus returned an HTTP error',
  INCUS_API_ERROR: 'Incus returned an API error',
  INCUS_INVALID_RESPONSE: 'Incus returned an invalid response',
  INCUS_JSON_ERROR: 'Incus returned invalid JSON',
  INCUS_NOT_FOUND: 'The requested Incus resource was not found',
  INCUS_UNAUTHORIZED: 'Incus authentication was rejected',
  INCUS_FORBIDDEN: 'Incus authorization was rejected',
  INCUS_BAD_REQUEST: 'Incus rejected the request',
  ETAG_CONFLICT: 'The Incus resource changed before it could be updated',
  INSTANCE_BUSY: 'The Incus instance is busy',
  OPERATION_FAILED: 'The Incus operation failed',
  SERVER_UNREACHABLE: 'The Incus server is unreachable',
  INCUS_TIMEOUT: 'The Incus request timed out',
  TLS_ERROR: 'The Incus TLS connection failed',
  TLS_PIN_MISMATCH: 'The Incus server certificate did not match its pin',
  INVALID_ENDPOINT: 'The Incus endpoint is invalid',
  MISSING_MANAGED_NETWORK_ADDRESS: 'The managed Incus network device is missing',
  INVALID_MANAGED_NETWORK_TYPE: 'The managed Incus network device is not bridged',
  INVALID_MANAGED_FILTER_IDENTITY: 'The managed Incus network filter identity is invalid',
  INVALID_INSTANCE_SPEC: 'The managed Incus instance specification is invalid',
  INVALID_INSTANCE_ID: 'The managed Incus instance ID is invalid',
  INVALID_IMAGE_FINGERPRINT: 'The managed Incus image fingerprint is invalid',
  INVALID_VOLUME_NAME: 'The managed Incus volume name is invalid',
  INVALID_ATTACHMENT_PATH: 'The managed Incus attachment path is invalid',
  IMAGE_NOT_AVAILABLE: 'The requested image is not available',
  VOLUME_SECURITY_SHIFTED_MISMATCH: 'The managed volume does not have security.shifted enabled',
  VOLUME_SHRINK_BELOW_USAGE: 'The requested volume size is below current usage',
  ROOT_SHRINK_BELOW_USAGE: 'The requested root disk size is below current usage',
  VOLUME_SHRINK_REQUIRES_DETACH: 'A block-backed volume must be detached before shrinking',
  VOLUME_SHRINK_REQUIRES_STOP: 'A block-backed volume consumer must be stopped before shrinking',
  VOLUME_RESIZE_UNSUPPORTED: 'The storage driver does not support the requested resize',
  ROOT_SHRINK_REQUIRES_STOP: 'The root disk must be stopped before shrinking',
  ROOT_QUOTA_PENDING: 'The root filesystem quota is still being applied',
  SSH_DAEMON_PENDING: 'SSH key is applied but the daemon is not accepting connections yet',
  GUEST_NOT_READY: 'The guest is not ready for network configuration',
  RESTART_BASELINE_MISSING: 'A restart intent is missing its observed started_at baseline',
  RESTART_PROOF_MISSING: 'The restart could not be proven from state.started_at',
  PREFLIGHT_IDENTITY_MISMATCH: 'The Incus server identity did not match the registered server',
  PREFLIGHT_CLEANUP_FAILED: 'The preflight probe cleanup failed',
  PREFLIGHT_FAILED: 'The server preflight checks failed',
  TRUST_TOKEN_MISSING: 'The server trust token is missing or expired',
  TRUST_TOKEN_UNAVAILABLE: 'The ephemeral trust-token store is unavailable',
  TRUST_TOKEN_REJECTED: 'The Incus server rejected the trust token',
  MISSING_STORAGE_POOL: 'The managed storage pool is unavailable',
  RESOURCE_NEEDS_ATTENTION: 'The resource requires operator attention',
  VOLUME_PLACEMENT_PENDING: 'The custom volume is not yet present on this Incus',
  VOLUME_CATALOG_ADOPT_PENDING: 'Incus has not adopted the existing CephFS directory into this catalog',
};

export class IncusError extends Error {
  readonly code: IncusFailureCode;
  readonly disposition: IncusErrorDisposition;
  readonly details: IncusErrorDetails;

  constructor(
    code: IncusFailureCode,
    disposition: IncusErrorDisposition,
    details: IncusErrorDetails = {},
  ) {
    super(FAILURE_MESSAGES[code]);
    this.name = 'IncusError';
    this.code = code;
    this.disposition = disposition;
    this.details = Object.freeze({ ...details });
  }
}

export interface IncusApiFailureInput {
  readonly status: number;
  readonly apiErrorCode?: number;
  readonly errorText?: string;
  readonly operationId?: string;
  readonly details?: IncusErrorDetails;
}

export interface IncusOperationFailureInput {
  readonly operationId?: string;
  readonly statusCode?: number;
  readonly errorCode?: number;
  readonly status?: string;
  readonly errorText?: string;
  readonly details?: IncusErrorDetails;
}

const BUSY_INSTANCE_ERROR = /^Instance is busy running a "([A-Za-z0-9_.:-]{1,64})" operation$/;

export function matchBusyInstanceError(errorText: unknown): { action: string } | undefined {
  if (typeof errorText !== 'string') {
    return undefined;
  }

  const match = BUSY_INSTANCE_ERROR.exec(errorText);
  return match ? { action: match[1] } : undefined;
}

export function mapIncusApiFailure(input: IncusApiFailureInput): IncusError {
  const busy = matchBusyInstanceError(input.errorText);
  if (busy) {
    return new IncusError('INSTANCE_BUSY', 'retry', busy);
  }

  const details: Record<string, IncusErrorDetailValue> = {
    status: input.status,
  };
  if (typeof input.apiErrorCode === 'number' && Number.isSafeInteger(input.apiErrorCode)) {
    details.apiErrorCode = input.apiErrorCode;
  }
  if (input.operationId) {
    details.operationId = input.operationId;
  }
  if (input.errorText) {
    details.error = input.errorText.slice(0, 512);
  }
  if (input.details) {
    Object.assign(details, input.details);
  }

  if (input.status === 404) {
    return new IncusError('INCUS_NOT_FOUND', 'managed_failure', details);
  }
  if (input.status === 401) {
    return new IncusError('INCUS_UNAUTHORIZED', 'managed_failure', details);
  }
  if (input.status === 403) {
    return new IncusError('INCUS_FORBIDDEN', 'managed_failure', details);
  }
  if (input.status === 400) {
    return new IncusError('INCUS_BAD_REQUEST', 'managed_failure', details);
  }
  if (input.status === 412) {
    return new IncusError('ETAG_CONFLICT', 'retry', details);
  }
  if (input.status === 408 || input.status === 429) {
    return new IncusError('INCUS_HTTP_ERROR', 'retry', details);
  }
  if (input.status >= 500) {
    return new IncusError('INCUS_HTTP_ERROR', 'retry', details);
  }
  if (input.status >= 400) {
    return new IncusError('INCUS_API_ERROR', 'managed_failure', details);
  }

  return new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', details);
}

export function isMissingCustomVolumeError(error: unknown): boolean {
  if (!(error instanceof IncusError)) return false;
  if (error.code !== 'INCUS_BAD_REQUEST' && error.code !== 'INCUS_NOT_FOUND') return false;
  const text = String(error.details?.error ?? '').toLowerCase();
  return (
    (text.includes('storage volume')
      && (text.includes('not found') || text.includes('no such') || text.includes('missing')))
    || (/failed to (start|create|add) device/.test(text) && text.includes('volume'))
  );
}

export function isAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof IncusError)) return false;
  const status = error.details?.status;
  if (status === 409) return true;
  if (error.code !== 'INCUS_BAD_REQUEST' && error.code !== 'INCUS_API_ERROR') return false;
  const text = String(error.details?.error ?? error.message ?? '').toLowerCase();
  return text.includes('already exists')
    || text.includes('already exist')
    || text.includes('file exists')
    || text.includes('eexist');
}

export function mapIncusOperationFailure(input: IncusOperationFailureInput): IncusError {
  const busy = matchBusyInstanceError(input.errorText);
  if (busy) {
    return new IncusError('INSTANCE_BUSY', 'retry', busy);
  }

  const details: Record<string, IncusErrorDetailValue> = {};
  if (input.operationId) {
    details.operationId = input.operationId;
  }
  if (typeof input.statusCode === 'number' && Number.isSafeInteger(input.statusCode)) {
    details.statusCode = input.statusCode;
  }
  if (typeof input.errorCode === 'number' && Number.isSafeInteger(input.errorCode)) {
    details.errorCode = input.errorCode;
  }
  if (input.status) {
    details.status = input.status.slice(0, 128);
  }
  if (input.errorText) {
    details.error = input.errorText.slice(0, 512);
  }
  if (input.details) {
    Object.assign(details, input.details);
  }

  const disposition =
    typeof input.statusCode === 'number' &&
    (input.statusCode >= 500 || input.statusCode === 408 || input.statusCode === 429)
      ? 'retry'
      : 'managed_failure';
  return new IncusError('OPERATION_FAILED', disposition, details);
}

export function mapIncusTransportError(
  error: unknown,
  phase: 'connect' | 'headers' | 'body' | 'total' = 'connect',
): IncusError {
  if (error instanceof IncusError) {
    return error;
  }

  const errorCode =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;

  if (
    phase === 'total' ||
    phase === 'headers' ||
    phase === 'body' ||
    errorCode === 'ETIMEDOUT' ||
    errorCode === 'ESOCKETTIMEDOUT'
  ) {
    return new IncusError('INCUS_TIMEOUT', 'retry', { phase });
  }

  if (
    errorCode === 'ECONNREFUSED' ||
    errorCode === 'ECONNRESET' ||
    errorCode === 'EHOSTUNREACH' ||
    errorCode === 'ENETUNREACH' ||
    errorCode === 'ENOTFOUND' ||
    errorCode === 'EAI_AGAIN'
  ) {
    return new IncusError('SERVER_UNREACHABLE', 'retry', { phase });
  }

  if (
    typeof errorCode === 'string' &&
    (errorCode.startsWith('CERT_') ||
      errorCode.startsWith('ERR_TLS_') ||
      errorCode === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      errorCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
  ) {
    return new IncusError('TLS_ERROR', 'retry', { phase });
  }

  return new IncusError('SERVER_UNREACHABLE', 'retry', { phase });
}

export function normalizeCertificateFingerprint(value: string): string {
  const normalized = value.replace(/[:-\s]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new IncusError('TLS_PIN_MISMATCH', 'managed_failure');
  }
  return normalized;
}
