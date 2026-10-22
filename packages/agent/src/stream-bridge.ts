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

/**
 * Relay frames both ways, preserving text/binary, until either side closes.
 * `held` are frames `left` received before the bridge existed; they go first.
 */
export function bridgeSockets(
  left: WebSocket,
  right: WebSocket,
  held: { readonly frames: ReadonlyArray<[RawData, boolean]>; readonly closed: boolean } = { frames: [], closed: false },
): void {
  let closed = false;
  const closeBoth = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    for (const socket of [left, right]) {
      if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
      else socket.terminate();
    }
  };
  const forward = (from: WebSocket, to: WebSocket): void => {
    from.on('message', (data, isBinary) => {
      if (to.readyState !== WebSocket.OPEN) return;
      if (to.bufferedAmount > MAX_BUFFERED_BYTES) {
        closeBoth(1013, 'stream peer is not reading');
        return;
      }
      to.send(data, { binary: isBinary });
    });
    from.on('close', (code, reason) => closeBoth(normalizeCloseCode(code), reason.toString().slice(0, 120)));
    from.on('error', () => closeBoth(1011, 'stream error'));
  };
  for (const [data, isBinary] of held.frames) {
    if (right.readyState === WebSocket.OPEN) right.send(data, { binary: isBinary });
  }
  forward(left, right);
  forward(right, left);
  if (held.closed || left.readyState === WebSocket.CLOSED) closeBoth(1000, 'incus closed the stream');
}

function normalizeCloseCode(code: number): number {
  // 1005/1006/1015 are reserved and may not be sent on the wire.
  if (code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) {
    return code;
  }
  return 1000;
}
