import WebSocket, { type RawData } from 'ws';
import { AGENT_STREAM_CONNECT_TIMEOUT_MS, MAX_AGENT_STREAM_FRAME_BYTES } from '@nyabase/common';

/** Drop a stream whose peer stops reading rather than buffer without bound. */
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

/** Dial the Backend's stream endpoint for one Incus WebSocket. */
export function dialBackendStream(url: string, credential: string, ca?: Buffer): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${credential}` },
      ca,
      handshakeTimeout: AGENT_STREAM_CONNECT_TIMEOUT_MS,
      maxPayload: MAX_AGENT_STREAM_FRAME_BYTES,
      perMessageDeflate: false,
    });
    const fail = (error: Error): void => {
      socket.removeAllListeners('open');
      socket.terminate();
      reject(error);
    };
    socket.once('open', () => {
      socket.removeListener('error', fail);
      resolve(socket);
    });
    socket.once('error', fail);
    socket.once('unexpected-response', (_request, response) => {
      fail(new Error(`Backend refused the stream (${response.statusCode ?? 0})`));
    });
  });
}

export interface BridgeOptions {
  /** The control session the stream belongs to; the bridge closes when it ends. */
  readonly session?: AbortSignal;
  /**
   * Ping `right` (the Backend side) this often and drop the bridge when a
   * ping goes unanswered, so a half-open link cannot keep an idle exec (and
   * the shell behind it) alive forever.
   */
  readonly heartbeatMs?: number;
  /**
   * Rewrite (or drop, by returning undefined) every frame `left` sends before
   * it reaches `right`; the result goes out as a text frame.
   */
  readonly filterLeft?: (text: string) => string | undefined;
}

/**
 * Relay frames both ways, preserving text/binary, until either side closes.
 * `held` are frames `left` received before the bridge existed; they go first.
 */
export function bridgeSockets(
  left: WebSocket,
  right: WebSocket,
  held: { readonly frames: ReadonlyArray<[RawData, boolean]>; readonly closed: boolean } = { frames: [], closed: false },
  options: BridgeOptions = {},
): void {
  let closed = false;
  let alive = true;
  const heartbeat = options.heartbeatMs
    ? setInterval(() => {
      if (!alive) {
        // A half-open peer never completes a close handshake.
        right.terminate();
        closeBoth(1001, 'stream peer stopped answering');
        return;
      }
      alive = false;
      if (right.readyState === WebSocket.OPEN) right.ping();
    }, options.heartbeatMs)
    : undefined;
  const endOfSession = (): void => closeBoth(1001, 'agent control connection closed');
  function closeBoth(code: number, reason: string): void {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    options.session?.removeEventListener('abort', endOfSession);
    for (const socket of [left, right]) {
      if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
      else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
  }
  const markAlive = (): void => {
    alive = true;
  };
  right.on('pong', markAlive);
  right.on('ping', markAlive);
  right.on('message', markAlive);
  const relay = (to: WebSocket, data: RawData, isBinary: boolean, filter?: (text: string) => string | undefined): void => {
    if (!filter) {
      to.send(data, { binary: isBinary });
      return;
    }
    const kept = filter(rawText(data));
    if (kept !== undefined) to.send(kept, { binary: false });
  };
  const forward = (from: WebSocket, to: WebSocket, filter?: (text: string) => string | undefined): void => {
    from.on('message', (data, isBinary) => {
      if (to.readyState !== WebSocket.OPEN) return;
      if (to.bufferedAmount > MAX_BUFFERED_BYTES) {
        closeBoth(1013, 'stream peer is not reading');
        return;
      }
      relay(to, data, isBinary, filter);
    });
    from.on('close', (code, reason) => closeBoth(normalizeCloseCode(code), reason.toString().slice(0, 120)));
    from.on('error', () => closeBoth(1011, 'stream error'));
  };
  for (const [data, isBinary] of held.frames) {
    if (right.readyState === WebSocket.OPEN) relay(right, data, isBinary, options.filterLeft);
  }
  forward(left, right, options.filterLeft);
  forward(right, left);
  if (options.session?.aborted) endOfSession();
  else options.session?.addEventListener('abort', endOfSession, { once: true });
  if (held.closed || left.readyState === WebSocket.CLOSED) closeBoth(1000, 'incus closed the stream');
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function normalizeCloseCode(code: number): number {
  // 1005/1006/1015 are reserved and may not be sent on the wire.
  if (code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) {
    return code;
  }
  return 1000;
}
