import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import {
  AgentToBackendMessage,
  BackendToAgentMessage,
  zEnvelope,
  sleep,
} from '@nyabase/common';

export interface WsClientOptions {
  url: string;
  token: string;
  onConnect?: () => void | Promise<void>;
  onDisconnect?: () => void;
}

const PING_INTERVAL_MS = 30_000;

export class AgentWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30_000;
  private stopped = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private messageHandler?: (msg: BackendToAgentMessage) => Promise<void>;

  constructor(private options: WsClientOptions) {
    super();
  }

  /**
   * Set the handler that processes inbound messages from the backend.
   * Must be called before `start()`.
   */
  setMessageHandler(fn: (msg: BackendToAgentMessage) => Promise<void>): void {
    this.messageHandler = fn;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearPingTimer();
    this.ws?.close();
  }

  send(msg: AgentToBackendMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect(): void {
    if (this.stopped) return;

    console.log(`[WS] Connecting to ${this.options.url}...`);
    this.ws = new WebSocket(this.options.url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
    });

    this.ws.on('open', () => {
      console.log('[WS] Connected');
      this.reconnectDelay = 1000;
      this.startPingTimer();
      this.options.onConnect?.()?.catch((e: unknown) => {
        console.error('[WS] onConnect error:', e);
      });
    });

    this.ws.on('message', async (raw) => {
      if (!this.messageHandler) return;
      try {
        const envelope = zEnvelope.parse(JSON.parse(raw.toString())) as BackendToAgentMessage;
        await this.messageHandler(envelope);
      } catch (err) {
        console.error('[WS] Failed to handle message:', err);
      }
    });

    this.ws.on('pong', () => {
      // Pong received — connection is alive, nothing else to do
    });

    this.ws.on('close', async (code, reason) => {
      console.warn(`[WS] Disconnected: ${code} ${reason}`);
      this.clearPingTimer();
      this.options.onDisconnect?.();
      if (!this.stopped) {
        await sleep(this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        this.connect();
      }
    });

    this.ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
    });
  }

  private startPingTimer(): void {
    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, PING_INTERVAL_MS);
    // Don't prevent the process from exiting if only the ping timer is active
    this.pingTimer.unref?.();
  }

  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
