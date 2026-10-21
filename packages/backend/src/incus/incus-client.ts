import type { IncomingHttpHeaders } from 'node:http';
import { IncusError, normalizeCertificateFingerprint } from './incus-errors.js';
import type {
  IncusClientOptions,
  IncusClientPort,
  IncusExecFd,
  IncusExecWebSocketOptions,
  IncusExecWebSocketSession,
  IncusFileResponse,
  IncusFileWriteOptions,
  IncusHttpMethod,
  IncusOperationWaitOptions,
  IncusRequestOptions,
  IncusResponse,
  IncusSchema,
  IncusTrustCertificateOptions,
  IncusWebSocketLike,
} from './incus-client-types.js';
import { headerValue, parseNumberHeader } from './incus-http-exchange.js';
import { operationIdFromEnvelope } from './incus-operation.js';
import {
  IncusTransport,
  appendQuery,
  boundedTimeout,
  encodeCertificateForPost,
  encodeImageAliasName,
  encodeSegment,
} from './incus-transport.js';

/**
 * The Incus REST client: every endpoint is declared here and issued through an
 * IncusTransport (endpoint allow-listing, mTLS pinning, request execution).
 */
export class IncusClient implements IncusClientPort {
  private readonly transport: IncusTransport;

  constructor(options: IncusClientOptions) {
    this.transport = new IncusTransport(options);
  }

  get endpoint(): string {
    return this.transport.endpoint;
  }

  get pinnedFingerprint(): string | undefined {
    return this.transport.pinnedFingerprint;
  }

  requestJson<T>(
    method: IncusHttpMethod,
    path: string,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<T>> {
    return this.transport.requestJson<T>(method, path, options);
  }

  requestRaw(
    method: IncusHttpMethod,
    path: string,
    options: IncusRequestOptions = {},
  ): Promise<IncusFileResponse> {
    return this.transport.requestRaw(method, path, options);
  }

  dialWebSocket(path: string, signal?: AbortSignal): Promise<IncusWebSocketLike> {
    return this.transport.dialWebSocket(path, signal);
  }

  getServer(options?: IncusRequestOptions): Promise<IncusResponse<IncusSchema<'Server'>>> {
    return this.transport.requestJson('GET', '/1.0', options);
  }

  trustClientCertificate(
    trustToken: string,
    name: string,
    options: IncusTrustCertificateOptions = {},
  ): Promise<IncusResponse<unknown>> {
    const certificatePem =
      options.certificatePem ??
      (typeof this.transport.tlsOptions.cert === 'string'
        ? this.transport.tlsOptions.cert
        : this.transport.tlsOptions.cert.toString('utf8'));
    return this.transport.requestJson('POST', '/1.0/certificates', {
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
      return await this.transport.requestJson(
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
    return this.transport.requestJson('PUT', '/1.0', { ...options, body: document });
  }

  patchServer(
    document: Partial<IncusSchema<'ServerPut'>>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.transport.requestJson('PATCH', '/1.0', { ...options, body: document });
  }

  getResources(options?: IncusRequestOptions): Promise<IncusResponse<IncusSchema<'Resources'>>> {
    return this.transport.requestJson('GET', '/1.0/resources', options);
  }

  getNetwork(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'Network'>>> {
    return this.transport.requestJson(
      'GET',
      `/1.0/networks/${encodeSegment(name, 'network_name')}`,
      options,
    );
  }

  getNetworkState(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'NetworkState'>>> {
    return this.transport.requestJson(
      'GET',
      `/1.0/networks/${encodeSegment(name, 'network_name')}/state`,
      options,
    );
  }

  listNetworks(options?: IncusRequestOptions): Promise<IncusResponse<string[]>> {
    return this.transport.requestJson('GET', '/1.0/networks', options);
  }

  listInstances(
    recursion: 1 | 2 = 2,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<IncusSchema<'Instance'>[] | IncusSchema<'InstanceFull'>[]>> {
    return this.transport.requestJson('GET', appendQuery('/1.0/instances', { recursion }), options);
  }

  getInstance(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'Instance'>>> {
    return this.transport.requestJson(
      'GET',
      `/1.0/instances/${encodeSegment(name, 'instance_name')}`,
      options,
    );
  }

  getInstanceFull(
    name: string,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<IncusSchema<'InstanceFull'>>> {
    return this.transport.requestJson(
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
    return this.transport.requestJson('POST', `/1.0/instances/${encodeSegment(name, 'instance_name')}`, {
      ...options,
      body: document,
    });
  }

  createInstance(
    document: IncusSchema<'InstancesPost'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.transport.requestJson('POST', '/1.0/instances', { ...options, body: document });
  }

  updateInstance(
    name: string,
    document: IncusSchema<'InstancePut'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.transport.requestJson('PUT', `/1.0/instances/${encodeSegment(name, 'instance_name')}`, {
      ...options,
      body: document,
    });
  }

  patchInstance(
    name: string,
    document: Partial<IncusSchema<'InstancePut'>>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.transport.requestJson('PATCH', `/1.0/instances/${encodeSegment(name, 'instance_name')}`, {
      ...options,
      body: document,
    });
  }

  deleteInstance(name: string, options?: IncusRequestOptions): Promise<IncusResponse<unknown>> {
    return this.transport.requestJson(
      'DELETE',
      `/1.0/instances/${encodeSegment(name, 'instance_name')}`,
      options,
    );
  }

  getInstanceState(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'InstanceState'>>> {
    return this.transport.requestJson(
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
    return this.transport.requestJson('PUT', `/1.0/instances/${encodeSegment(name, 'instance_name')}/state`, {
      ...options,
      body: document,
    });
  }

  execInstance(
    name: string,
    document: IncusSchema<'InstanceExecPost'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.transport.requestJson('POST', `/1.0/instances/${encodeSegment(name, 'instance_name')}/exec`, {
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
          sockets[channel] = await this.transport.dialWebSocket(
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
    const response = await this.transport.executeRequest(
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
    return this.transport.requestJson('POST', this.filePath(name, filePath, options.project), {
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
    return this.transport.requestJson('DELETE', this.filePath(name, filePath, options.project), {
      signal: options.signal,
    });
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

  listStoragePools(
    recursion: 0 | 1 = 1,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<IncusSchema<'StoragePool'>[]>> {
    return this.transport.requestJson('GET', appendQuery('/1.0/storage-pools', { recursion }), options);
  }

  getStoragePool(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'StoragePool'>>> {
    return this.transport.requestJson(
      'GET',
      `/1.0/storage-pools/${encodeSegment(name, 'storage_pool')}`,
      options,
    );
  }

  getStoragePoolResources(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'ResourcesStoragePool'>>> {
    return this.transport.requestJson(
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
    return this.transport.requestJson(
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
    return this.transport.requestJson(
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
    return this.transport.requestJson(
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
    return this.transport.requestJson(
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
    return this.transport.requestJson(
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
    return this.transport.requestJson(
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
    return this.transport.requestJson('GET', appendQuery('/1.0/images', { recursion }), options);
  }

  getImage(
    fingerprint: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'Image'>>> {
    return this.transport.requestJson(
      'GET',
      `/1.0/images/${encodeSegment(fingerprint, 'image_fingerprint')}`,
      options,
    );
  }

  createImage(
    document: IncusSchema<'ImagesPost'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.transport.requestJson('POST', '/1.0/images', { ...options, body: document });
  }

  updateImage(
    fingerprint: string,
    document: IncusSchema<'ImagePut'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.transport.requestJson(
      'PUT',
      `/1.0/images/${encodeSegment(fingerprint, 'image_fingerprint')}`,
      { ...options, body: document },
    );
  }

  deleteImage(fingerprint: string, options?: IncusRequestOptions): Promise<IncusResponse<unknown>> {
    return this.transport.requestJson(
      'DELETE',
      `/1.0/images/${encodeSegment(fingerprint, 'image_fingerprint')}`,
      options,
    );
  }

  createImageAlias(
    document: IncusSchema<'ImageAliasesPost'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.transport.requestJson('POST', '/1.0/images/aliases', { ...options, body: document });
  }

  async deleteImageAlias(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    try {
      return await this.transport.requestJson(
        'DELETE',
        `/1.0/images/aliases/${encodeImageAliasName(name)}`,
        options,
      );
    } catch (error) {
      if (error instanceof IncusError && error.code === 'INCUS_NOT_FOUND') {
        return {
          status: 404,
          headers: {},
          envelope: { type: 'sync', status: 'Success', status_code: 200, metadata: {} },
          metadata: {},
        };
      }
      throw error;
    }
  }

  getOperationWait(
    operationId: string,
    options: IncusOperationWaitOptions = {},
  ): Promise<IncusResponse<IncusSchema<'Operation'>>> {
    const timeoutMs = boundedTimeout(options.timeoutMs, this.transport.operationWaitTimeoutMs);
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    return this.transport.requestJson(
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
    return this.transport.requestJson(
      'GET',
      `/1.0/operations/${encodeSegment(operationId, 'operation_id')}`,
      options,
    );
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
