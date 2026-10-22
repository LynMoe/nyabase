import * as http from 'node:http';
import WebSocket, { type RawData } from 'ws';
import { MAX_AGENT_INCUS_BODY_BYTES, type AgentIncusHttpMethod } from '@nyabase/common';

export interface LocalIncusRequest {
  readonly method: AgentIncusHttpMethod;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Buffer;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface LocalIncusResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

/**
 * An open Incus WebSocket whose frames are held from the moment it opened,
 * so nothing Incus sends before it is bridged is lost.
 */
export interface HeldWebSocket {
  readonly socket: WebSocket;
  /** Stop holding: the frames received so far, and whether Incus already closed it. */
  release(): { readonly frames: Array<[RawData, boolean]>; readonly closed: boolean };
}

export class LocalIncusError extends Error {
  constructor(
    readonly code: 'incus_unavailable' | 'timeout' | 'cancelled' | 'too_large',
    message: string,
  ) {
    super(message);
  }
}

/** Request headers the Backend may forward to Incus (file transfer metadata and ETags). */
const FORWARDED_REQUEST_HEADERS = new Set([
  'content-type',
  'if-match',
  'x-incus-uid',
  'x-incus-gid',
  'x-incus-mode',
  'x-incus-type',
  'x-incus-write',
]);

/** The local Incus daemon over its unix socket; the only Incus endpoint the agent knows. */
export class LocalIncus {
  constructor(private readonly socketPath: string) {}

  request(input: LocalIncusRequest): Promise<LocalIncusResponse> {
    const headers: Record<string, string> = { accept: 'application/json' };
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      const key = name.toLowerCase();
      if (FORWARDED_REQUEST_HEADERS.has(key)) headers[key] = value;
    }
    if (input.body) headers['content-length'] = String(input.body.byteLength);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | undefined, value?: LocalIncusResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value!);
      };
      const request = http.request({
        socketPath: this.socketPath,
        path: input.path,
        method: input.method,
        headers,
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_AGENT_INCUS_BODY_BYTES) {
            request.destroy();
            finish(new LocalIncusError('too_large', 'Incus response exceeds the tunnel body limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => finish(undefined, {
          status: response.statusCode ?? 0,
          headers: flattenHeaders(response.headers),
          body: Buffer.concat(chunks),
        }));
        response.on('error', (error) => finish(new LocalIncusError('incus_unavailable', error.message)));
      });
      const timer = setTimeout(() => {
        request.destroy();
        finish(new LocalIncusError('timeout', 'Incus request timed out'));
      }, input.timeoutMs);
      const abort = (): void => {
        request.destroy();
        finish(new LocalIncusError('cancelled', 'Incus request was cancelled'));
      };
      if (input.signal?.aborted) {
        abort();
        return;
      }
      input.signal?.addEventListener('abort', abort, { once: true });
      request.on('error', (error) => finish(new LocalIncusError('incus_unavailable', error.message)));
      request.end(input.body);
    });
  }

  async requestJson<T>(method: AgentIncusHttpMethod, path: string, timeoutMs = 10_000): Promise<T> {
    const response = await this.request({ method, path, timeoutMs });
    const parsed = JSON.parse(response.body.toString('utf8')) as { metadata?: T; error?: string };
    if (response.status < 200 || response.status >= 300) {
      throw new LocalIncusError('incus_unavailable', parsed.error ?? `Incus returned ${response.status}`);
    }
    return parsed.metadata as T;
  }

  /** Open an Incus WebSocket (events, operation channels) over the unix socket. */
  dialWebSocket(path: string, timeoutMs: number): Promise<HeldWebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws+unix://${this.socketPath}:${path}`, {
        handshakeTimeout: timeoutMs,
        maxPayload: MAX_AGENT_INCUS_BODY_BYTES,
        perMessageDeflate: false,
      });
      const fail = (error: Error): void => {
        socket.removeAllListeners('open');
        socket.terminate();
        reject(new LocalIncusError('incus_unavailable', error.message));
      };
      socket.once('open', () => {
        socket.removeListener('error', fail);
        const frames: Array<[RawData, boolean]> = [];
        let closed = false;
        const hold = (data: RawData, isBinary: boolean): void => {
          frames.push([data, isBinary]);
        };
        const markClosed = (): void => {
          closed = true;
        };
        socket.on('message', hold);
        socket.once('close', markClosed);
        socket.on('error', () => undefined);
        resolve({
          socket,
          release: () => {
            socket.removeListener('message', hold);
            socket.removeListener('close', markClosed);
            return { frames, closed };
          },
        });
      });
      socket.once('error', fail);
      socket.once('unexpected-response', (_request, response) => {
        fail(new Error(`Incus refused the WebSocket (${response.statusCode ?? 0})`));
      });
    });
  }
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}
