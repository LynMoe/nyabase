import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import type { ClientOptions as WebSocketClientOptions } from 'ws';
import type { components } from './api-types.js';

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
  createImageAlias(
    document: IncusSchema<'ImageAliasesPost'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>>;
  deleteImageAlias(name: string, options?: IncusRequestOptions): Promise<IncusResponse<unknown>>;
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
