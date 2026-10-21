import { IncusError } from './incus-errors.js';
import type {
  IncusExecFd,
  IncusExecWebSocketOptions,
  IncusExecWebSocketSession,
  IncusFileResponse,
  IncusFileWriteOptions,
  IncusRequestOptions,
  IncusResponse,
  IncusSchema,
  IncusWebSocketLike,
} from './incus-client-types.js';
import {
  appendQuery,
  encodeModeHeader,
  encodeSegment,
  extractExecFileDescriptors,
  headerValue,
  operationIdFromEnvelope,
  parseModeHeader,
  parseNumberHeader,
} from './incus-request-util.js';
import { IncusServerApi } from './incus-server-api.js';

/** Instance lifecycle, state, exec and file endpoints. */
export class IncusInstanceApi extends IncusServerApi {
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

  protected filePath(name: string, filePath: string, project?: string): string {
    if (!filePath || /[\u0000-\u001f\u007f]/.test(filePath)) {
      throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', { reason: 'file_path' });
    }
    return appendQuery(`/1.0/instances/${encodeSegment(name, 'instance_name')}/files`, {
      path: filePath,
      project,
    });
  }
}
