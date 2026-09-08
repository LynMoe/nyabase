/** Matches SQL CHECK: 1–63 characters, already anchored. */
export const SERVER_CARD_EXTENSION_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;

export type ExtensionId = string;
export type OpaqueExtensionMap = Record<string, unknown>;

/** Closed set of host widgets. Host-prerequisite support is core-rendered, not a slot. */
export type ServerCardUiArea =
  | 'server.detail.enablement'
  | 'server.detail.health'
  | 'server.preflight'
  | 'container.create'
  | 'container.spec'
  | 'container.overview'
  | 'grant.server';

export type ExtensionSupportCheckStatus = 'pass' | 'fail' | 'unknown';

export interface ExtensionSupportCheckDto {
  readonly id: string;
  readonly label: string;
  readonly status: ExtensionSupportCheckStatus;
  readonly detail?: string;
}

/**
 * Host prerequisite probe for a compiled-in server-card module.
 * Independent of admin enablement and of persisted operational health.
 * `supported` is true when every check passed, false when any failed,
 * and null when none failed but at least one check is unknown.
 */
export interface ExtensionSupportDto {
  readonly supported: boolean | null;
  readonly checks: readonly ExtensionSupportCheckDto[];
}

export function summarizeExtensionSupport(
  checks: readonly ExtensionSupportCheckDto[],
): ExtensionSupportDto {
  let sawUnknown = false;
  for (const check of checks) {
    if (check.status === 'fail') return { supported: false, checks };
    if (check.status === 'unknown') sawUnknown = true;
  }
  return { supported: sawUnknown ? null : true, checks };
}

export interface ServerExtensionEnablementDto {
  readonly extensionId: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly health: OpaqueExtensionMap;
  readonly occupiedDeviceCount: number;
  readonly support: ExtensionSupportDto;
}

export interface ExtensionDevicesResponseDto {
  readonly items: unknown[];
  readonly enabled: boolean;
}

/**
 * Package-thrown HTTP error. Not a Nest HttpException; the host filter
 * maps it to `{ statusCode, code, message, details }`.
 */
export class PackageHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'PackageHttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isPackageHttpError(error: unknown): error is PackageHttpError {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as {
    name?: unknown;
    statusCode?: unknown;
    code?: unknown;
    details?: unknown;
  };
  return record.name === 'PackageHttpError'
    && typeof record.statusCode === 'number'
    && typeof record.code === 'string'
    && typeof record.details === 'object'
    && record.details !== null;
}

export type ExtensionErrorFormatter = (code: string) => string | undefined;
