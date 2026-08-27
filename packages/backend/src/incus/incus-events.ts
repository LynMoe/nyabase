import type { IncusClientPort, IncusSchema, IncusWebSocketLike } from './incus-client.js';

export interface IncusEventWake {
  readonly kind: 'wake';
  readonly reason: 'event' | 'disconnected' | 'reconnected';
  readonly receivedAt: number;
  readonly event?: IncusSchema<'Event'>;
}

export interface IncusEventSubscriptionOptions {
  readonly path?: string;
  readonly signal?: AbortSignal;
  readonly initialReconnectMs?: number;
  readonly maxReconnectMs?: number;
}

interface PendingNext {
  readonly resolve: (result: IteratorResult<IncusEventWake>) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEvent(value: unknown): IncusSchema<'Event'> | undefined {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (Buffer.isBuffer(value)) {
    text = value.toString('utf8');
  } else if (value instanceof ArrayBuffer) {
    text = Buffer.from(value).toString('utf8');
  } else if (value instanceof Uint8Array) {
    text = Buffer.from(value).toString('utf8');
  } else {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? (parsed as IncusSchema<'Event'>) : undefined;
  } catch {
    return undefined;
  }
}

function boundedReconnect(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > 120_000) {
    throw new RangeError('Incus event reconnect delay is out of bounds');
  }
  return result;
}

export class IncusEventWakeStream implements AsyncIterable<IncusEventWake> {
  private readonly path: string;
  private readonly signal?: AbortSignal;
  private readonly initialReconnectMs: number;
  private readonly maxReconnectMs: number;
  private readonly queue: IncusEventWake[] = [];
  private readonly pending: PendingNext[] = [];
  private socket?: IncusWebSocketLike;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelay: number;
  private stopped = false;
  private hasConnected = false;

  constructor(
    private readonly client: Pick<IncusClientPort, 'dialWebSocket'>,
    options: IncusEventSubscriptionOptions = {},
  ) {
    this.path = options.path ?? '/1.0/events';
    this.signal = options.signal;
    this.initialReconnectMs = boundedReconnect(options.initialReconnectMs, 250);
    this.maxReconnectMs = boundedReconnect(options.maxReconnectMs, 10_000);
    if (this.maxReconnectMs < this.initialReconnectMs) {
      throw new RangeError('Incus event reconnect maximum is below the initial delay');
    }
    this.reconnectDelay = this.initialReconnectMs;
    if (this.signal?.aborted) {
      this.stop();
    } else {
      this.signal?.addEventListener('abort', this.abort, { once: true });
      void this.connect();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<IncusEventWake> {
    return this;
  }

  next(): Promise<IteratorResult<IncusEventWake>> {
    const item = this.queue.shift();
    if (item) {
      return Promise.resolve({ done: false, value: item });
    }
    if (this.stopped) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise<IteratorResult<IncusEventWake>>((resolve) => {
      this.pending.push({ resolve });
    });
  }

  return(): Promise<IteratorResult<IncusEventWake>> {
    this.stop();
    return Promise.resolve({ done: true, value: undefined });
  }

  close(): void {
    this.stop();
  }

  private readonly abort = (): void => {
    this.stop();
  };

  private async connect(): Promise<void> {
    if (this.stopped || this.socket) return;
    try {
      const socket = await this.client.dialWebSocket(this.path, this.signal);
      if (this.stopped) {
        socket.close(1000, 'aborted');
        return;
      }
      this.socket = socket;
      this.reconnectDelay = this.initialReconnectMs;
      const wasConnected = this.hasConnected;
      this.hasConnected = true;
      if (wasConnected) {
        this.enqueue({
          kind: 'wake',
          reason: 'reconnected',
          receivedAt: Date.now(),
        });
      }
      const onMessage = (data: unknown): void => {
        const event = parseEvent(data);
        if (!event || this.stopped || this.socket !== socket) return;
        this.enqueue({
          kind: 'wake',
          reason: 'event',
          receivedAt: Date.now(),
          event,
        });
      };
      const onDisconnect = (): void => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        if (!this.stopped) {
          this.enqueue({
            kind: 'wake',
            reason: 'disconnected',
            receivedAt: Date.now(),
          });
          this.scheduleReconnect();
        }
      };
      socket.on('message', onMessage);
      socket.once('close', onDisconnect);
      socket.once('error', onDisconnect);
    } catch {
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.maxReconnectMs, this.reconnectDelay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  private enqueue(wake: IncusEventWake): void {
    const waiter = this.pending.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: wake });
      return;
    }
    this.queue.push(wake);
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.signal?.removeEventListener('abort', this.abort);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, 'closed');
    for (const waiter of this.pending.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }
}

export function subscribeIncusEvents(
  client: Pick<IncusClientPort, 'dialWebSocket'>,
  options?: IncusEventSubscriptionOptions,
): IncusEventWakeStream {
  return new IncusEventWakeStream(client, options);
}
