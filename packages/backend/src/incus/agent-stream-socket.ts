import { EventEmitter } from 'node:events';
import WebSocket, { type RawData } from 'ws';
import type { IncusWebSocketLike } from './incus-client-types.js';

/**
 * What a stream may hold before anyone listens. The window is normally a few
 * milliseconds; an agent that floods it is cut off instead of growing the heap.
 */
export const MAX_BUFFERED_STREAM_BYTES = 16 * 1024 * 1024;
export const MAX_BUFFERED_STREAM_FRAMES = 4_096;
/** WebSocket close code 1009: message too big. */
const CLOSE_BUFFER_OVERFLOW = 1009;

/**
 * An agent stream socket handed to Backend code. The agent may relay Incus
 * frames before the caller has its listeners in place (the stream is accepted
 * before the incus.ws reply arrives), so frames are held until the first
 * `message` listener is attached and then replayed in order; a close that
 * arrives meanwhile is delivered after them. Overflowing the buffer drops the
 * held frames, terminates the stream and delivers an error and a 1009 close.
 */
export class BufferedStreamSocket extends EventEmitter implements IncusWebSocketLike {
  private buffered: Array<[RawData, boolean]> | null = [];
  private bufferedBytes = 0;
  private pendingClose: [number, Buffer] | null = null;
  private overflow: Error | null = null;
  private flushScheduled = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly maxBufferedBytes = MAX_BUFFERED_STREAM_BYTES,
    private readonly maxBufferedFrames = MAX_BUFFERED_STREAM_FRAMES,
  ) {
    super();
    socket.on('message', (data, isBinary) => {
      if (this.overflow) return;
      if (this.buffered) this.hold(data, isBinary);
      else this.emit('message', data, isBinary);
    });
    socket.on('close', (code, reason) => {
      if (this.overflow) return;
      if (!this.buffered) {
        this.emit('close', code, reason);
        return;
      }
      this.pendingClose = [code, reason];
      if (this.listenerCount('close') > 0) this.scheduleFlush('close');
    });
    socket.on('error', (error) => {
      if (this.overflow) return;
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  /** Frames received so far that nobody consumed yet (for tests and diagnostics). */
  get bufferedCount(): number {
    return this.buffered?.length ?? 0;
  }

  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    super.on(event, listener);
    this.scheduleFlush(event);
    return this;
  }

  override once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    super.once(event, listener);
    this.scheduleFlush(event);
    return this;
  }

  send(data: string | Buffer): void {
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  terminate(): void {
    this.socket.terminate();
  }

  /**
   * Flush once the caller has finished registering listeners synchronously:
   * right away for a message listener, a little later when only close is watched.
   */
  private scheduleFlush(event: string | symbol): void {
    if (!this.buffered || this.flushScheduled) return;
    if (event === 'message') {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    } else if (event === 'close' && this.pendingClose) {
      this.flushScheduled = true;
      setImmediate(() => this.flush());
    }
  }

  private hold(data: RawData, isBinary: boolean): void {
    this.buffered!.push([data, isBinary]);
    this.bufferedBytes += rawDataBytes(data);
    if (this.bufferedBytes <= this.maxBufferedBytes && this.buffered!.length <= this.maxBufferedFrames) return;
    this.overflow = new Error(
      `agent stream buffered more than ${this.maxBufferedBytes} bytes or ${this.maxBufferedFrames} frames before anyone listened`,
    );
    this.buffered = [];
    this.bufferedBytes = 0;
    this.pendingClose = [CLOSE_BUFFER_OVERFLOW, Buffer.from('stream buffer overflow')];
    this.socket.terminate();
    if (this.listenerCount('close') > 0) this.scheduleFlush('close');
  }

  private flush(): void {
    const frames = this.buffered;
    if (!frames) return;
    this.buffered = null;
    for (const [data, isBinary] of frames) this.emit('message', data, isBinary);
    if (this.overflow && this.listenerCount('error') > 0) this.emit('error', this.overflow);
    if (this.pendingClose) {
      const [code, reason] = this.pendingClose;
      this.pendingClose = null;
      this.emit('close', code, reason);
    }
  }
}

function rawDataBytes(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.length, 0);
  return data.byteLength;
}

export function isOpen(socket: WebSocket): boolean {
  return socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING;
}
