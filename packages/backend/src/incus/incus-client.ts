import { createHash } from 'node:crypto';
import * as https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import WebSocket, { type ClientOptions as WebSocketClientOptions } from 'ws';
import type { components } from './api-types.js';
import {
  IncusError,
  mapIncusApiFailure,
  mapIncusTransportError,
  normalizeCertificateFingerprint,
} from './incus-errors.js';

export type IncusSchema<Name extends keyof components['schemas']> = components['schemas'][Name];

export type IncusHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface IncusEnvelope<T> {
  readonly type?: string;
  readonly status?: string;
  readonly status_code?: number;
  readonly operation?: string;
  readonly metadata?: T;
  readonly error?: string;
  readonly error_code?: number;
}

export interface IncusResponse<T> {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly etag?: string;
  readonly envelope: IncusEnvelope<T>;
  readonly metadata: T;
}

export interface IncusFileResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly etag?: string;
  readonly body: Buffer;
  readonly uid?: number;
  readonly gid?: number;
  readonly mode?: number;
  readonly type?: string;
  readonly modified?: string;
}

export interface IncusTimeouts {
  readonly connectMs: number;
  readonly headersMs: number;
  readonly bodyMs: number;
  readonly totalMs: number;
}

export interface IncusTlsOptions {
  readonly cert: string | Buffer;
  readonly key: string | Buffer;
  readonly ca?: string | Buffer | readonly (string | Buffer)[];
  readonly fingerprint?: string;
  readonly expectedFingerprint?: string;
  readonly onFirstFingerprint?: (fingerprint: string) => void | Promise<void>;
}

export interface IncusClientOptions {
  readonly endpoint: string;
  readonly allowedHosts: readonly string[];
  readonly tls: IncusTlsOptions;
  readonly timeouts?: Partial<IncusTimeouts>;
  readonly operationWaitTimeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly requestFactory?: IncusRequestFactory;
  readonly websocketFactory?: IncusWebSocketFactory;
}

export interface IncusRequestLike {
  on(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  setTimeout(timeout: number, callback?: () => void): this;
  write(chunk: string | Buffer): boolean;
  end(): void;
  destroy(error?: Error): this;
}

export type IncusRequestFactory = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => IncusRequestLike;

export interface IncusWebSocketLike {
  on(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): this;
  terminate?(): void;
  readonly readyState?: number;
}

export type IncusWebSocketFactory = (
  url: string,
  options: WebSocketClientOptions,
) => IncusWebSocketLike;

export interface IncusRequestOptions {
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly ifMatch?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly responseType?: 'json' | 'raw';
}

export interface IncusTrustCertificateOptions extends IncusRequestOptions {
  readonly certificatePem?: string;
}

export interface IncusFileWriteOptions {
  readonly uid?: number;
  readonly gid?: number;
  readonly mode?: number;
  readonly type?: 'file' | 'directory' | 'symlink';
  readonly write?: 'overwrite' | 'append';
  readonly project?: string;
  readonly signal?: AbortSignal;
}

export type IncusExecFd = '0' | '1' | '2' | 'control';

export interface IncusExecWebSocketOptions {
  readonly signal?: AbortSignal;
  readonly channels?: readonly IncusExecFd[];
}

export interface IncusExecWebSocketSession {
  readonly operationId: string;
  readonly sockets: Readonly<Partial<Record<IncusExecFd, IncusWebSocketLike>>>;
  close(): void;
}

export interface IncusOperationWaitOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface IncusClientPort {
  readonly endpoint: string;
  requestJson<T>(
    method: IncusHttpMethod,
    path: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<T>>;
  requestRaw(
    method: IncusHttpMethod,
    path: string,
    options?: IncusRequestOptions,
  ): Promise<IncusFileResponse>;
  getServer(options?: IncusRequestOptions): Promise<IncusResponse<IncusSchema<'Server'>>>;
  trustClientCertificate(
    trustToken: string,
    name: string,
    options?: IncusTrustCertificateOptions,
  ): Promise<IncusResponse<unknown>>;
  trustCertificate(
    certificatePem: string,
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>>;
  deleteClientCertificate(
    fingerprint: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>>;
  updateServer(
    document: IncusSchema<'ServerPut'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>>;
  patchServer(
    document: Partial<IncusSchema<'ServerPut'>>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>>;
  getResources(options?: IncusRequestOptions): Promise<IncusResponse<IncusSchema<'Resources'>>>;
  getNetwork(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'Network'>>>;
  getNetworkState(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'NetworkState'>>>;
  listNetworks(options?: IncusRequestOptions): Promise<IncusResponse<string[]>>;
  listInstances(
    recursion?: 1 | 2,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'Instance'>[] | IncusSchema<'InstanceFull'>[]>>;
  getInstance(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'Instance'>>>;
  getInstanceFull(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'InstanceFull'>>>;
  renameInstance(
    name: string,
    document: IncusSchema<'InstancePost'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>>;
  createInstance(
    document: IncusSchema<'InstancesPost'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>>;
  updateInstance(
    name: string,
    document: IncusSchema<'InstancePut'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>>;
  patchInstance(
    name: string,
    document: Partial<IncusSchema<'InstancePut'>>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>>;
  deleteInstance(name: string, options?: IncusRequestOptions): Promise<IncusResponse<unknown>>;
  getInstanceState(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'InstanceState'>>>;
  updateInstanceState(
    name: string,
    document: IncusSchema<'InstanceStatePut'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>>;
  execInstance(
    name: string,
    document: IncusSchema<'InstanceExecPost'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>>;
  openExecWebSockets(
    name: string,
    document: IncusSchema<'InstanceExecPost'>,
    options?: IncusExecWebSocketOptions,
  ): Promise<IncusExecWebSocketSession>;
  getFile(
    name: string,
    filePath: string,
    options?: Pick<IncusFileWriteOptions, 'project' | 'signal'>,
  ): Promise<IncusFileResponse>;
  putFile(
    name: string,
    filePath: string,
    content: Buffer | string,
    options?: IncusFileWriteOptions,
  ): Promise<IncusResponse<unknown>>;
  deleteFile(
    name: string,
    filePath: string,
    options?: Pick<IncusFileWriteOptions, 'project' | 'signal'>,
  ): Promise<IncusResponse<unknown>>;
  listStoragePools(
    recursion?: 0 | 1,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'StoragePool'>[]>>;
  getStoragePool(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'StoragePool'>>>;
  getStoragePoolResources(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'ResourcesStoragePool'>>>;
  listStorageVolumes(
    poolName: string,
    type?: string,
    recursion?: 0 | 1,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'StorageVolume'>[]>>;
  getStorageVolume(
    poolName: string,
    type: string,
    volumeName: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'StorageVolume'>>>;
  getStorageVolumeState(
    poolName: string,
    type: string,
    volumeName: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'StorageVolumeState'>>>;
  createStorageVolume(
    poolName: string,
    document: IncusSchema<'StorageVolumesPost'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>>;
  updateStorageVolume(
    poolName: string,
    type: string,
    volumeName: string,
    document: IncusSchema<'StorageVolumePut'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>>;
  deleteStorageVolume(
    poolName: string,
    type: string,
    volumeName: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>>;
  listImages(
    recursion?: 0 | 1,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'Image'>[]>>;
  getImage(
    fingerprint: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'Image'>>>;
  createImage(
    document: IncusSchema<'ImagesPost'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>>;
  updateImage(
    fingerprint: string,
    document: IncusSchema<'ImagePut'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>>;
  deleteImage(fingerprint: string, options?: IncusRequestOptions): Promise<IncusResponse<unknown>>;
  getOperationWait(
    operationId: string,
    options?: IncusOperationWaitOptions,
  ): Promise<IncusResponse<IncusSchema<'Operation'>>>;
  getOperation(
    operationId: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'Operation'>>>;
  dialWebSocket(path: string, signal?: AbortSignal): Promise<IncusWebSocketLike>;
  readModifyWriteInstance<T>(
    name: string,
    mutate: (document: IncusSchema<'InstancePut'>) => T | IncusSchema<'InstancePut'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<T | unknown>>;
}

const DEFAULT_TIMEOUTS: IncusTimeouts = {
  connectMs: 5_000,
  headersMs: 10_000,
  bodyMs: 10_000,
  totalMs: 30_000,
};

const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;

function boundedTimeout(value: number | undefined, fallback: number): number {
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

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function encodeSegment(value: string, label: string): string {
  if (!value || value === '.' || value === '..' || /[\u0000-\u001f\u007f/\\]/.test(value)) {
    throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', { reason: label });
  }
  return encodeURIComponent(value);
}

function appendQuery(
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

function cloneRecord<T>(value: T): T {
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

function parseNumberHeader(headers: IncomingHttpHeaders, name: string): number | undefined {
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
function parseModeHeader(headers: IncomingHttpHeaders, name: string): number | undefined {
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
function encodeModeHeader(mode: number): string {
  if (!Number.isSafeInteger(mode) || mode < 0) {
    throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', { reason: 'invalid_file_mode' });
  }
  return `0${mode.toString(8)}`;
}

function mutableCa(
  ca: string | Buffer | readonly (string | Buffer)[] | undefined,
): string | Buffer | (string | Buffer)[] | undefined {
  if (Array.isArray(ca)) {
    return Array.from(ca) as (string | Buffer)[];
  }
  return ca as string | Buffer | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodeCertificateForPost(certificatePem: string): string {
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

function extractExecFileDescriptors(
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

export class IncusClient implements IncusClientPort {
  readonly endpoint: string;

  private readonly baseUrl: URL;
  private readonly tlsOptions: IncusTlsOptions;
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly timeouts: IncusTimeouts;
  private readonly operationWaitTimeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly requestFactory: IncusRequestFactory;
  private readonly websocketFactory: IncusWebSocketFactory;
  private serverFingerprint?: string;
  private firstFingerprintPromise?: Promise<void>;

  constructor(options: IncusClientOptions) {
    this.baseUrl = this.validateEndpoint(options.endpoint, options.allowedHosts);
    this.endpoint = this.baseUrl.origin;
    this.allowedHosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
    this.tlsOptions = options.tls;
    this.timeouts = normalizeTimeouts(options.timeouts);
    this.operationWaitTimeoutMs = boundedTimeout(
      options.operationWaitTimeoutMs,
      DEFAULT_TIMEOUTS.totalMs,
    );
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (
      !Number.isSafeInteger(this.maxBodyBytes) ||
      this.maxBodyBytes <= 0 ||
      this.maxBodyBytes > 128 * 1024 * 1024
    ) {
      throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
        reason: 'body_limit',
      });
    }
    if (!options.tls.cert || !options.tls.key) {
      throw new IncusError('TLS_ERROR', 'managed_failure');
    }
    if (options.tls.fingerprint) {
      this.serverFingerprint = normalizeCertificateFingerprint(options.tls.fingerprint);
    }
    if (!this.serverFingerprint && !options.tls.onFirstFingerprint) {
      throw new IncusError('TLS_PIN_MISMATCH', 'managed_failure');
    }
    this.requestFactory =
      options.requestFactory ??
      ((requestOptions, callback) => https.request(requestOptions, callback));
    this.websocketFactory =
      options.websocketFactory ?? ((url, websocketOptions) => new WebSocket(url, websocketOptions));
  }

  get pinnedFingerprint(): string | undefined {
    return this.serverFingerprint;
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

  getServer(options?: IncusRequestOptions): Promise<IncusResponse<IncusSchema<'Server'>>> {
    return this.requestJson('GET', '/1.0', options);
  }

  trustClientCertificate(
    trustToken: string,
    name: string,
    options: IncusTrustCertificateOptions = {},
  ): Promise<IncusResponse<unknown>> {
    const certificatePem =
      options.certificatePem ??
      (typeof this.tlsOptions.cert === 'string'
        ? this.tlsOptions.cert
        : this.tlsOptions.cert.toString('utf8'));
    return this.requestJson('POST', '/1.0/certificates', {
      ...options,
      body: {
        certificate: encodeCertificateForPost(certificatePem),
        name,
        type: 'client',
        ...(trustToken ? { trust_token: trustToken } : {}),
      },
    });
  }

  trustCertificate(
    certificatePem: string,
    name: string,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<unknown>> {
    return this.trustClientCertificate('', name, {
      ...options,
      certificatePem,
    });
  }

  async deleteClientCertificate(
    fingerprint: string,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<unknown>> {
    const normalized = normalizeCertificateFingerprint(fingerprint);
    try {
      return await this.requestJson(
        'DELETE',
        `/1.0/certificates/${encodeSegment(normalized, 'certificate_fingerprint')}`,
        options,
      );
    } catch (error) {
      if (error instanceof IncusError && error.code === 'INCUS_NOT_FOUND') {
        return {
          status: 404,
          headers: {},
          envelope: {
            type: 'sync',
            status: 'Success',
            status_code: 200,
            metadata: {},
          },
          metadata: {},
        };
      }
      throw error;
    }
  }

  updateServer(
    document: IncusSchema<'ServerPut'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson('PUT', '/1.0', { ...options, body: document });
  }

  patchServer(
    document: Partial<IncusSchema<'ServerPut'>>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson('PATCH', '/1.0', { ...options, body: document });
  }

  getResources(options?: IncusRequestOptions): Promise<IncusResponse<IncusSchema<'Resources'>>> {
    return this.requestJson('GET', '/1.0/resources', options);
  }

  getNetwork(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'Network'>>> {
    return this.requestJson(
      'GET',
      `/1.0/networks/${encodeSegment(name, 'network_name')}`,
      options,
    );
  }

  getNetworkState(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'NetworkState'>>> {
    return this.requestJson(
      'GET',
      `/1.0/networks/${encodeSegment(name, 'network_name')}/state`,
      options,
    );
  }

  listNetworks(options?: IncusRequestOptions): Promise<IncusResponse<string[]>> {
    return this.requestJson('GET', '/1.0/networks', options);
  }

  listInstances(
    recursion: 1 | 2 = 2,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<IncusSchema<'Instance'>[] | IncusSchema<'InstanceFull'>[]>> {
    return this.requestJson('GET', appendQuery('/1.0/instances', { recursion }), options);
  }

  getInstance(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'Instance'>>> {
    return this.requestJson(
      'GET',
      `/1.0/instances/${encodeSegment(name, 'instance_name')}`,
      options,
    );
  }

  getInstanceFull(
    name: string,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<IncusSchema<'InstanceFull'>>> {
    return this.requestJson(
      'GET',
      appendQuery(`/1.0/instances/${encodeSegment(name, 'instance_name')}`, { recursion: 1 }),
      options,
    );
  }

  renameInstance(
    name: string,
    document: IncusSchema<'InstancePost'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson('POST', `/1.0/instances/${encodeSegment(name, 'instance_name')}`, {
      ...options,
      body: document,
    });
  }

  createInstance(
    document: IncusSchema<'InstancesPost'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson('POST', '/1.0/instances', { ...options, body: document });
  }

  updateInstance(
    name: string,
    document: IncusSchema<'InstancePut'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson('PUT', `/1.0/instances/${encodeSegment(name, 'instance_name')}`, {
      ...options,
      body: document,
    });
  }

  patchInstance(
    name: string,
    document: Partial<IncusSchema<'InstancePut'>>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson('PATCH', `/1.0/instances/${encodeSegment(name, 'instance_name')}`, {
      ...options,
      body: document,
    });
  }

  deleteInstance(name: string, options?: IncusRequestOptions): Promise<IncusResponse<unknown>> {
    return this.requestJson(
      'DELETE',
      `/1.0/instances/${encodeSegment(name, 'instance_name')}`,
      options,
    );
  }

  getInstanceState(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'InstanceState'>>> {
    return this.requestJson(
      'GET',
      `/1.0/instances/${encodeSegment(name, 'instance_name')}/state`,
      options,
    );
  }

  updateInstanceState(
    name: string,
    document: IncusSchema<'InstanceStatePut'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson('PUT', `/1.0/instances/${encodeSegment(name, 'instance_name')}/state`, {
      ...options,
      body: document,
    });
  }

  execInstance(
    name: string,
    document: IncusSchema<'InstanceExecPost'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson('POST', `/1.0/instances/${encodeSegment(name, 'instance_name')}/exec`, {
      ...options,
      body: document,
    });
  }

  async openExecWebSockets(
    name: string,
    document: IncusSchema<'InstanceExecPost'>,
    options: IncusExecWebSocketOptions = {},
  ): Promise<IncusExecWebSocketSession> {
    const response = await this.execInstance(
      name,
      {
        ...document,
        'wait-for-websocket': true,
      },
      { signal: options.signal },
    );
    const operationId = operationIdFromEnvelope(response.envelope);
    const fds = extractExecFileDescriptors(response.metadata);
    const requestedChannels =
      options.channels ??
      (document.interactive ? (['0', 'control'] as const) : (['0', '1', '2'] as const));
    const sockets: Partial<Record<IncusExecFd, IncusWebSocketLike>> = {};
    try {
      await Promise.all(
        requestedChannels.map(async (channel) => {
          const secret = fds[channel];
          if (!secret) {
            throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
              reason: `missing_exec_fd_${channel}`,
            });
          }
          sockets[channel] = await this.dialWebSocket(
            `/1.0/operations/${encodeSegment(operationId, 'operation_id')}/websocket?secret=${encodeURIComponent(secret)}`,
            options.signal,
          );
        }),
      );
    } catch (error) {
      for (const socket of Object.values(sockets)) {
        socket?.close();
      }
      throw error;
    }
    return {
      operationId,
      sockets,
      close: () => {
        for (const socket of Object.values(sockets)) {
          socket?.close(1000, 'closed');
        }
      },
    };
  }

  async getFile(
    name: string,
    filePath: string,
    options: Pick<IncusFileWriteOptions, 'project' | 'signal'> = {},
  ): Promise<IncusFileResponse> {
    const response = await this.executeRequest(
      'GET',
      this.filePath(name, filePath, options.project),
      { responseType: 'raw', signal: options.signal },
    );
    if (response.kind !== 'raw') {
      throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
        reason: 'expected_file',
      });
    }
    return {
      ...response.value,
      uid: parseNumberHeader(response.value.headers, 'x-incus-uid'),
      gid: parseNumberHeader(response.value.headers, 'x-incus-gid'),
      mode: parseModeHeader(response.value.headers, 'x-incus-mode'),
      type: headerValue(response.value.headers, 'x-incus-type'),
      modified: headerValue(response.value.headers, 'x-incus-modified'),
    };
  }

  putFile(
    name: string,
    filePath: string,
    content: Buffer | string,
    options: IncusFileWriteOptions = {},
  ): Promise<IncusResponse<unknown>> {
    const headers: Record<string, string> = {};
    if (options.uid !== undefined) headers['X-Incus-uid'] = String(options.uid);
    if (options.gid !== undefined) headers['X-Incus-gid'] = String(options.gid);
    if (options.mode !== undefined) headers['X-Incus-mode'] = encodeModeHeader(options.mode);
    if (options.type !== undefined) headers['X-Incus-type'] = options.type;
    if (options.write !== undefined) headers['X-Incus-write'] = options.write;
    return this.requestJson('POST', this.filePath(name, filePath, options.project), {
      body: Buffer.isBuffer(content) ? content : Buffer.from(content),
      headers,
      signal: options.signal,
    });
  }

  deleteFile(
    name: string,
    filePath: string,
    options: Pick<IncusFileWriteOptions, 'project' | 'signal'> = {},
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson('DELETE', this.filePath(name, filePath, options.project), {
      signal: options.signal,
    });
  }

  listStoragePools(
    recursion: 0 | 1 = 1,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<IncusSchema<'StoragePool'>[]>> {
    return this.requestJson('GET', appendQuery('/1.0/storage-pools', { recursion }), options);
  }

  getStoragePool(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'StoragePool'>>> {
    return this.requestJson(
      'GET',
      `/1.0/storage-pools/${encodeSegment(name, 'storage_pool')}`,
      options,
    );
  }

  getStoragePoolResources(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'ResourcesStoragePool'>>> {
    return this.requestJson(
      'GET',
      `/1.0/storage-pools/${encodeSegment(name, 'storage_pool')}/resources`,
      options,
    );
  }

  listStorageVolumes(
    poolName: string,
    type = 'custom',
    recursion: 0 | 1 = 1,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<IncusSchema<'StorageVolume'>[]>> {
    // Incus filters by volume type via the path segment (/volumes/custom). A
    // `?type=` query is ignored and returns mixed types (including container
    // root volumes), which then 404 when probed as custom.
    return this.requestJson(
      'GET',
      appendQuery(
        `/1.0/storage-pools/${encodeSegment(poolName, 'storage_pool')}/volumes/${encodeSegment(
          type,
          'volume_type',
        )}`,
        { recursion },
      ),
      options,
    );
  }

  getStorageVolume(
    poolName: string,
    type: string,
    volumeName: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'StorageVolume'>>> {
    return this.requestJson(
      'GET',
      `/1.0/storage-pools/${encodeSegment(poolName, 'storage_pool')}/volumes/${encodeSegment(
        type,
        'volume_type',
      )}/${encodeSegment(volumeName, 'volume_name')}`,
      options,
    );
  }

  getStorageVolumeState(
    poolName: string,
    type: string,
    volumeName: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'StorageVolumeState'>>> {
    return this.requestJson(
      'GET',
      `/1.0/storage-pools/${encodeSegment(poolName, 'storage_pool')}/volumes/${encodeSegment(
        type,
        'volume_type',
      )}/${encodeSegment(volumeName, 'volume_name')}/state`,
      options,
    );
  }

  createStorageVolume(
    poolName: string,
    document: IncusSchema<'StorageVolumesPost'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson(
      'POST',
      `/1.0/storage-pools/${encodeSegment(poolName, 'storage_pool')}/volumes`,
      { ...options, body: document },
    );
  }

  updateStorageVolume(
    poolName: string,
    type: string,
    volumeName: string,
    document: IncusSchema<'StorageVolumePut'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson(
      'PUT',
      `/1.0/storage-pools/${encodeSegment(poolName, 'storage_pool')}/volumes/${encodeSegment(
        type,
        'volume_type',
      )}/${encodeSegment(volumeName, 'volume_name')}`,
      { ...options, body: document },
    );
  }

  deleteStorageVolume(
    poolName: string,
    type: string,
    volumeName: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson(
      'DELETE',
      `/1.0/storage-pools/${encodeSegment(poolName, 'storage_pool')}/volumes/${encodeSegment(
        type,
        'volume_type',
      )}/${encodeSegment(volumeName, 'volume_name')}`,
      options,
    );
  }

  listImages(
    recursion: 0 | 1 = 1,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<IncusSchema<'Image'>[]>> {
    return this.requestJson('GET', appendQuery('/1.0/images', { recursion }), options);
  }

  getImage(
    fingerprint: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'Image'>>> {
    return this.requestJson(
      'GET',
      `/1.0/images/${encodeSegment(fingerprint, 'image_fingerprint')}`,
      options,
    );
  }

  createImage(
    document: IncusSchema<'ImagesPost'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson('POST', '/1.0/images', { ...options, body: document });
  }

  updateImage(
    fingerprint: string,
    document: IncusSchema<'ImagePut'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson(
      'PUT',
      `/1.0/images/${encodeSegment(fingerprint, 'image_fingerprint')}`,
      { ...options, body: document },
    );
  }

  deleteImage(fingerprint: string, options?: IncusRequestOptions): Promise<IncusResponse<unknown>> {
    return this.requestJson(
      'DELETE',
      `/1.0/images/${encodeSegment(fingerprint, 'image_fingerprint')}`,
      options,
    );
  }

  getOperationWait(
    operationId: string,
    options: IncusOperationWaitOptions = {},
  ): Promise<IncusResponse<IncusSchema<'Operation'>>> {
    const timeoutMs = boundedTimeout(options.timeoutMs, this.operationWaitTimeoutMs);
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    return this.requestJson(
      'GET',
      appendQuery(`/1.0/operations/${encodeSegment(operationId, 'operation_id')}/wait`, {
        timeout: timeoutSeconds,
      }),
      { signal: options.signal, timeoutMs },
    );
  }

  getOperation(
    operationId: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'Operation'>>> {
    return this.requestJson(
      'GET',
      `/1.0/operations/${encodeSegment(operationId, 'operation_id')}`,
      options,
    );
  }

  private tlsPin(): string | undefined {
    return this.serverFingerprint ?? this.tlsOptions.expectedFingerprint;
  }

  private pinnedTlsSocketOptions(): {
    readonly ca: string | Buffer | Array<string | Buffer> | undefined;
    readonly rejectUnauthorized: boolean;
  } {
    // Multi-server Incus deployments each have their own self-signed leaf.
    // The control-plane bootstrap CA only matches the first host; once a leaf
    // fingerprint pin is present, disable CA rejection and enforce the pin in
    // checkServerIdentity / acceptPeerFingerprint instead.
    if (this.tlsPin()) {
      return { ca: undefined, rejectUnauthorized: false };
    }
    return {
      ca: mutableCa(this.tlsOptions.ca),
      rejectUnauthorized: true,
    };
  }

  async dialWebSocket(path: string, signal?: AbortSignal): Promise<IncusWebSocketLike> {
    const url = this.urlForPath(path);
    url.protocol = 'wss:';
    let peerFingerprintRaw: Buffer | undefined;
    const pinned = this.pinnedTlsSocketOptions();

    const websocketOptions: WebSocketClientOptions = {
      cert: this.tlsOptions.cert,
      key: this.tlsOptions.key,
      ca: pinned.ca,
      rejectUnauthorized: pinned.rejectUnauthorized,
      checkServerIdentity: ((hostname: string, certificate: unknown) => {
        const peerCertificate = certificate as Parameters<typeof checkServerIdentity>[1];
        if (!peerCertificate.raw) {
          return new Error('Incus TLS peer certificate is unavailable');
        }
        peerFingerprintRaw = peerCertificate.raw;
        // Fingerprint-pin mode is authoritative for Incus mTLS. Remote Incus
        // leaves often omit the LAN listen IP from SAN (only 127.0.0.1), so a
        // hostname check would reject a correctly pinned server certificate.
        const pin = this.tlsPin();
        if (pin) {
          try {
            assertLeafCertificateFingerprint(peerCertificate.raw, pin);
            return undefined;
          } catch {
            return new Error('Incus TLS certificate pin mismatch');
          }
        }
        return checkServerIdentity(hostname, peerCertificate);
      }) as unknown as NonNullable<WebSocketClientOptions['checkServerIdentity']>,
    };

    return new Promise<IncusWebSocketLike>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let socket: IncusWebSocketLike | undefined;
      const cleanup = (): void => {
        signal?.removeEventListener('abort', abort);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cleanup();
        socket?.close();
        reject(error instanceof IncusError ? error : mapIncusTransportError(error, 'connect'));
      };
      const abort = (): void => {
        if (settled) {
          socket?.close(1000, 'aborted');
          socket?.terminate?.();
          return;
        }
        fail(new IncusError('INCUS_TIMEOUT', 'retry', { phase: 'connect' }));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        fail(new IncusError('INCUS_TIMEOUT', 'retry', { phase: 'connect' }));
      }, this.timeouts.totalMs);
      try {
        socket = this.websocketFactory(url.toString(), websocketOptions);
        socket.once('open', () => {
          if (settled) return;
          void (async () => {
            if (!this.serverFingerprint) {
              if (!peerFingerprintRaw) {
                throw new IncusError('TLS_ERROR', 'retry', { phase: 'connect' });
              }
              await this.acceptPeerFingerprint(peerFingerprintRaw);
            }
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            cleanup();
            resolve(socket as IncusWebSocketLike);
          })().catch((error: unknown) => fail(error));
        });
        socket.once('close', () => {
          cleanup();
        });
        socket.once('error', (error: unknown) => fail(error));
        socket.once('close', () => {
          if (!settled) {
            fail(new Error('Incus websocket closed during connect'));
          }
        });
      } catch (error) {
        fail(error);
      }
    });
  }

  async readModifyWriteInstance<T>(
    name: string,
    mutate: (document: IncusSchema<'InstancePut'>) => T | IncusSchema<'InstancePut'>,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<T | unknown>> {
    const actual = await this.getInstanceFull(name, { signal: options.signal });
    if (!actual.etag) {
      throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
        reason: 'missing_etag',
      });
    }

    const document: IncusSchema<'InstancePut'> = {
      architecture: actual.metadata.architecture,
      config: cloneRecord(actual.metadata.config),
      description: actual.metadata.description,
      devices: cloneRecord(actual.metadata.devices),
      ephemeral: actual.metadata.ephemeral,
      profiles: [],
      stateful: actual.metadata.stateful,
    };
    const mutationResult = mutate(document);
    const nextDocument =
      mutationResult && typeof mutationResult === 'object' && !Array.isArray(mutationResult)
        ? (mutationResult as IncusSchema<'InstancePut'>)
        : document;
    nextDocument.profiles = [];
    const response = await this.updateInstance(name, nextDocument, {
      ...options,
      ifMatch: actual.etag,
    });
    return response as IncusResponse<T | unknown>;
  }

  private filePath(name: string, filePath: string, project?: string): string {
    if (!filePath || /[\u0000-\u001f\u007f]/.test(filePath)) {
      throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', { reason: 'file_path' });
    }
    return appendQuery(`/1.0/instances/${encodeSegment(name, 'instance_name')}/files`, {
      path: filePath,
      project,
    });
  }

  private validateEndpoint(endpoint: string, allowedHosts: readonly string[]): URL {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new IncusError('INVALID_ENDPOINT', 'managed_failure');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '' && url.pathname !== '/')
    ) {
      throw new IncusError('INVALID_ENDPOINT', 'managed_failure');
    }
    const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
    if (allowed.size === 0 || !allowed.has(url.hostname.toLowerCase())) {
      throw new IncusError('INVALID_ENDPOINT', 'managed_failure', {
        reason: 'host_not_allowlisted',
      });
    }
    return url;
  }

  private urlForPath(path: string): URL {
    const rawPath = path.split(/[?#]/, 1)[0];
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      /[\u0000-\u001f\u007f]/.test(path) ||
      /%2e|%2f|%5c/i.test(rawPath)
    ) {
      throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', { reason: 'path' });
    }
    const url = new URL(path, this.baseUrl);
    if (
      url.origin !== this.baseUrl.origin ||
      !this.allowedHosts.has(url.hostname.toLowerCase()) ||
      (url.pathname !== '/1.0' && !url.pathname.startsWith('/1.0/'))
    ) {
      throw new IncusError('INVALID_ENDPOINT', 'managed_failure');
    }
    return url;
  }

  private acceptPeerFingerprint(raw: Buffer): Promise<void> {
    const actualFingerprint = leafCertificateFingerprint(raw);
    const expectedFingerprint = this.tlsOptions.expectedFingerprint;
    if (
      expectedFingerprint &&
      actualFingerprint !== normalizeCertificateFingerprint(expectedFingerprint)
    ) {
      return Promise.reject(new IncusError('TLS_PIN_MISMATCH', 'managed_failure'));
    }
    if (this.serverFingerprint) {
      assertLeafCertificateFingerprint(raw, this.serverFingerprint);
      return Promise.resolve();
    }
    if (!this.tlsOptions.onFirstFingerprint) {
      return Promise.reject(new IncusError('TLS_PIN_MISMATCH', 'managed_failure'));
    }
    if (!this.firstFingerprintPromise) {
      const acceptance = Promise.resolve()
        .then(() => this.tlsOptions.onFirstFingerprint?.(actualFingerprint))
        .then(() => {
          this.serverFingerprint = actualFingerprint;
        });
      this.firstFingerprintPromise = acceptance.catch((error: unknown) => {
        this.firstFingerprintPromise = undefined;
        throw error;
      });
    }
    return this.firstFingerprintPromise.then(() => {
      if (this.serverFingerprint !== actualFingerprint) {
        throw new IncusError('TLS_PIN_MISMATCH', 'managed_failure');
      }
    });
  }

  private async executeRequest(
    method: IncusHttpMethod,
    path: string,
    options: IncusRequestOptions,
  ): Promise<
    | { readonly kind: 'json'; readonly value: IncusResponse<unknown> }
    | {
        readonly kind: 'raw';
        readonly value: Omit<IncusFileResponse, 'uid' | 'gid' | 'mode' | 'type' | 'modified'>;
      }
  > {
    const url = this.urlForPath(path);
    const headers: Record<string, string> = {
      accept: options.responseType === 'raw' ? '*/*' : 'application/json',
      ...options.headers,
    };
    for (const [name, value] of Object.entries(headers)) {
      assertHeaderValue(value, name);
    }
    if (options.ifMatch !== undefined) {
      assertHeaderValue(options.ifMatch, 'if-match');
      headers['If-Match'] = options.ifMatch;
    }

    let body: Buffer | undefined;
    if (options.body !== undefined) {
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
      headers['content-length'] = String(body.byteLength);
      if (body.byteLength > this.maxBodyBytes) {
        throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', {
          reason: 'request_body_too_large',
        });
      }
    }

    const pinned = this.pinnedTlsSocketOptions();
    const requestOptions: RequestOptions = {
      protocol: 'https:',
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      cert: this.tlsOptions.cert,
      key: this.tlsOptions.key,
      ca: pinned.ca,
      rejectUnauthorized: pinned.rejectUnauthorized,
      servername: url.hostname,
      checkServerIdentity: (hostname, certificate) => {
        // Prefer the leaf fingerprint pin over hostname/SAN matching. Incus
        // server certs commonly list only 127.0.0.1 even when core.https_address
        // is a LAN IP; connect/onboarding still pins the expected leaf.
        const pin = this.tlsPin();
        if (pin) {
          try {
            if (!certificate.raw) {
              return new Error('Incus TLS peer certificate is unavailable');
            }
            assertLeafCertificateFingerprint(certificate.raw, pin);
            return undefined;
          } catch {
            return new Error('Incus TLS certificate pin mismatch');
          }
        }
        return checkServerIdentity(hostname, certificate);
      },
    };

    const requestDeadlineMs = boundedTimeout(options.timeoutMs, this.timeouts.totalMs);
    const responseHeadersTimeoutMs =
      options.timeoutMs === undefined ? this.timeouts.headersMs : requestDeadlineMs;
    const responseBodyTimeoutMs =
      options.timeoutMs === undefined ? this.timeouts.bodyMs : requestDeadlineMs;

    return new Promise((resolve, reject) => {
      let request: IncusRequestLike | undefined;
      let settled = false;
      let phase: 'connect' | 'headers' | 'body' | 'total' = 'connect';
      let connectTimer: NodeJS.Timeout | undefined;
      let headersTimer: NodeJS.Timeout | undefined;
      let bodyTimer: NodeJS.Timeout | undefined;
      let totalTimer: NodeJS.Timeout | undefined;
      let tlsVerified = false;
      let tlsVerificationStarted = false;
      let tlsVerification: Promise<void> = new Promise(() => undefined);
      let activeSocket:
        | {
            setTimeout(timeout: number, callback?: () => void): void;
            once(event: string, listener: (...args: never[]) => void): void;
            removeListener?(event: string, listener: (...args: never[]) => void): unknown;
            getPeerCertificate?: (detailed?: boolean) => { raw?: Buffer };
            authorized?: boolean;
            secureConnecting?: boolean;
          }
        | undefined;
      let socketTimeoutCallback: (() => void) | undefined;
      let secureConnectListener: ((...args: never[]) => void) | undefined;
      const clearSocketTimeout = (): void => {
        if (!activeSocket) return;
        if (socketTimeoutCallback) {
          activeSocket.removeListener?.('timeout', socketTimeoutCallback);
          socketTimeoutCallback = undefined;
        }
        activeSocket.setTimeout(0);
      };
      const setSocketTimeout = (timeoutMs: number, callback: () => void): void => {
        clearSocketTimeout();
        if (!activeSocket) return;
        socketTimeoutCallback = callback;
        activeSocket.setTimeout(timeoutMs, callback);
      };
      const cleanup = (): void => {
        if (connectTimer) clearTimeout(connectTimer);
        if (headersTimer) clearTimeout(headersTimer);
        if (bodyTimer) clearTimeout(bodyTimer);
        if (totalTimer) clearTimeout(totalTimer);
        clearSocketTimeout();
        if (activeSocket && secureConnectListener) {
          activeSocket.removeListener?.('secureConnect', secureConnectListener);
          secureConnectListener = undefined;
        }
        options.signal?.removeEventListener('abort', abort);
      };
      const fail = (error: unknown, failurePhase = phase): void => {
        if (settled) return;
        settled = true;
        cleanup();
        request?.destroy(error instanceof Error ? error : undefined);
        reject(error instanceof IncusError ? error : mapIncusTransportError(error, failurePhase));
      };
      const abort = (): void => {
        fail(new IncusError('INCUS_TIMEOUT', 'retry', { phase: 'total' }), 'total');
      };
      const timeout = (timeoutPhase: 'connect' | 'headers' | 'body' | 'total'): void => {
        fail(new IncusError('INCUS_TIMEOUT', 'retry', { phase: timeoutPhase }), timeoutPhase);
      };
      const resetBodyTimer = (): void => {
        if (bodyTimer) clearTimeout(bodyTimer);
        bodyTimer = setTimeout(() => timeout('body'), responseBodyTimeoutMs);
      };
      const consumeResponse = (response: IncomingMessage): void => {
        if (settled) return;
        phase = 'body';
        if (connectTimer) clearTimeout(connectTimer);
        if (headersTimer) clearTimeout(headersTimer);
        resetBodyTimer();
        const chunks: Buffer[] = [];
        let bodyBytes = 0;
        const contentLength = parseNumberHeader(response.headers, 'content-length');
        if (contentLength !== undefined && contentLength > this.maxBodyBytes) {
          fail(
            new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
              reason: 'body_too_large',
            }),
            'body',
          );
          return;
        }
        response.on('data', (chunk: Buffer | string) => {
          if (settled) return;
          resetBodyTimer();
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bodyBytes += buffer.byteLength;
          if (bodyBytes > this.maxBodyBytes) {
            fail(
              new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
                reason: 'body_too_large',
              }),
              'body',
            );
            return;
          }
          chunks.push(buffer);
        });
        response.once('aborted', () => timeout('body'));
        response.once('error', (error: unknown) => fail(error, 'body'));
        response.once('end', () => {
          if (settled) return;
          const finish = (): void => {
            if (settled) return;
            if (bodyTimer) clearTimeout(bodyTimer);
            const payload = Buffer.concat(chunks);
            const complete = (value: Parameters<typeof resolve>[0]): void => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve(value);
            };
            this.finishResponse(
              response,
              payload,
              options.responseType ?? 'json',
              requestOptions.path ?? path,
              complete,
              fail,
            );
          };
          if (tlsVerified) {
            finish();
            return;
          }
          void tlsVerification.then(finish).catch((error: unknown) => fail(error, 'connect'));
        });
      };

      totalTimer = setTimeout(() => timeout('total'), requestDeadlineMs);
      headersTimer = setTimeout(() => timeout('headers'), responseHeadersTimeoutMs);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }

      try {
        request = this.requestFactory(requestOptions, (response) => {
          if (settled) return;
          consumeResponse(response);
        });
        request.once('error', (error: unknown) => fail(error, phase));
        request.once('socket', (socketValue: unknown) => {
          const socket = socketValue as NonNullable<typeof activeSocket>;
          activeSocket = socket;
          const markTlsVerified = (): void => {
            if (settled) return;
            tlsVerified = true;
            if (connectTimer) clearTimeout(connectTimer);
            phase = 'headers';
            setSocketTimeout(responseHeadersTimeoutMs, () => timeout('headers'));
          };
          const verifyTls = (): void => {
            if (settled || tlsVerified || tlsVerificationStarted) return;
            // An already-accepted leaf pin is enforced by checkServerIdentity.
            // After secureConnect, getPeerCertificate().raw can be empty on some
            // Node/OpenSSL paths (rejectUnauthorized=false); do not re-fail.
            // expectedFingerprint alone is not yet accepted — still TOFU-verify.
            if (this.serverFingerprint && socket.secureConnecting !== true) {
              tlsVerificationStarted = true;
              tlsVerification = Promise.resolve().then(markTlsVerified);
              return;
            }
            const certificate = socket.getPeerCertificate?.(true);
            if (!certificate?.raw) {
              if (socket.secureConnecting === true) {
                secureConnectListener = verifyTls;
                socket.once('secureConnect', secureConnectListener);
                return;
              }
              if (socket.authorized === true && this.serverFingerprint) {
                tlsVerificationStarted = true;
                try {
                  if (
                    this.tlsOptions.expectedFingerprint &&
                    this.serverFingerprint !==
                      normalizeCertificateFingerprint(this.tlsOptions.expectedFingerprint)
                  ) {
                    throw new IncusError('TLS_PIN_MISMATCH', 'managed_failure');
                  }
                  tlsVerification = Promise.resolve().then(markTlsVerified);
                } catch (error) {
                  fail(error, 'connect');
                }
                return;
              }
              fail(new IncusError('TLS_ERROR', 'retry', { phase: 'connect' }), 'connect');
              return;
            }
            tlsVerificationStarted = true;
            try {
              tlsVerification = this.acceptPeerFingerprint(certificate.raw)
                .then(markTlsVerified)
                .catch((error: unknown) => {
                  fail(error, 'connect');
                });
            } catch (error) {
              fail(error, 'connect');
            }
          };
          connectTimer = setTimeout(() => timeout('connect'), this.timeouts.connectMs);
          setSocketTimeout(this.timeouts.connectMs, () => timeout('connect'));
          // If the handshake is still in progress, wait for secureConnect. If it
          // already completed (including agent-reused sockets), verify immediately —
          // waiting for secureConnect after the fact hangs until connect timeout.
          if (socket.secureConnecting === true) {
            secureConnectListener = verifyTls;
            socket.once('secureConnect', secureConnectListener);
          } else {
            verifyTls();
          }
        });
        if (body) request.write(body);
        request.end();
      } catch (error) {
        fail(error, phase);
      }
    });
  }

  private finishResponse(
    response: IncomingMessage,
    payload: Buffer,
    responseType: 'json' | 'raw',
    requestPath: string,
    resolve: (
      value:
        | { readonly kind: 'json'; readonly value: IncusResponse<unknown> }
        | {
            readonly kind: 'raw';
            readonly value: Omit<IncusFileResponse, 'uid' | 'gid' | 'mode' | 'type' | 'modified'>;
          },
    ) => void,
    fail: (error: unknown, phase?: 'connect' | 'headers' | 'body' | 'total') => void,
  ): void {
    const status = response.statusCode ?? 0;
    const etag = headerValue(response.headers, 'etag');
    if (responseType === 'raw' && status >= 200 && status < 300) {
      resolve({
        kind: 'raw',
        value: { status, headers: response.headers, etag, body: payload },
      });
      return;
    }

    let parsed: unknown;
    if (payload.byteLength > 0) {
      try {
        parsed = JSON.parse(payload.toString('utf8'));
      } catch {
        if (status >= 400) {
          fail(
            mapIncusApiFailure({
              status,
              errorText: payload.toString('utf8').slice(0, 256),
              details: { path: requestPath },
            }),
            'body',
          );
        } else {
          fail(new IncusError('INCUS_JSON_ERROR', 'managed_failure', { status }), 'body');
        }
        return;
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
      fail(
        mapIncusApiFailure({
          status: apiStatus,
          apiErrorCode: envelope?.error_code,
          errorText: envelope?.error,
          operationId: envelope?.operation,
          details: { path: requestPath },
        }),
        'body',
      );
      return;
    }
    if (!envelope || typeof envelope !== 'object') {
      fail(new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', { status }), 'body');
      return;
    }

    resolve({
      kind: 'json',
      value: {
        status,
        headers: response.headers,
        etag,
        envelope,
        metadata: envelope.metadata,
      },
    });
  }
}
