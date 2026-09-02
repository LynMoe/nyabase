/** Matches SQL CHECK: 1–63 characters, already anchored. */
export const SERVER_CARD_EXTENSION_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;

export type ExtensionId = string;
export type OpaqueExtensionMap = Record<string, unknown>;

export type ServerCardUiArea =
  | 'server.detail.enablement'
  | 'server.detail.health'
  | 'server.preflight'
  | 'container.create'
  | 'container.spec'
  | 'container.overview'
  | 'grant.server';

export interface ServerExtensionEnablementDto {
  readonly extensionId: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly health: OpaqueExtensionMap;
  readonly occupiedDeviceCount: number;
}

export interface PatchServerExtensionRequest {
  readonly enabled: boolean;
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

export type ExtensionErrorFormatter = (code: string) => string | undefined;
