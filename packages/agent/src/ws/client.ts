import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import {
  AgentToBackendMessage,
  BackendToAgentMessage,
  zEnvelope,
  zAdmissionReadyPayload,
  sleep,
  MAX_AGENT_WS_FRAME_BYTES,
} from '@nyabase/common';

export interface WsClientOptions {
  url: string;
  token: string;
  serverId: string;
  onConnect?: (generation: number) => void | Promise<void>;
  onDisconnect?: () => void;
}

const PING_INTERVAL_MS = 30_000;
const MAX_BUFFERED_BYTES = MAX_AGENT_WS_FRAME_BYTES;

export class AgentWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30_000;
  private stopped = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private messageHandler?: (msg: BackendToAgentMessage) => Promise<void>;
  private socketGeneration = 0;
  private helloSentGeneration = 0;
  private admissionReadyGeneration = 0;
  private activeConnectionInitialization: Promise<void> | null = null;
  private pendingConnectionInitialization: { socket: WebSocket; generation: number } | null = null;

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
    this.pendingConnectionInitialization = null;
    this.clearPingTimer();
    this.ws?.close();
  }

  send(msg: AgentToBackendMessage, expectedGeneration?: number): boolean {
    if (this.stopped) return false;
    if (expectedGeneration !== undefined && expectedGeneration !== this.socketGeneration) return false;
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    if (this.admissionReadyGeneration !== this.socketGeneration) return false;
    // No timer, stale async collector, or Docker event may overtake hello on a
    // fresh socket. commandAck remains possible immediately after hello.
    if (msg.kind !== 'hello' && this.helloSentGeneration !== this.socketGeneration) return false;
    const encoded = JSON.stringify(msg);
    const encodedBytes = Buffer.byteLength(encoded);
    if (encodedBytes > MAX_AGENT_WS_FRAME_BYTES) {
      // Keep the control channel alive so the caller can replace an oversized
      // authoritative report with a small durable inventoryFault.
      console.error('[WS] Outbound frame exceeds the protocol limit');
      return false;
    }
    if (this.ws.bufferedAmount + encodedBytes > MAX_BUFFERED_BYTES) {
      if (msg.kind === 'stateReport' || msg.kind === 'inventoryFault') {
        // The caller owns the distinction between a valid report suffering
        // transport pressure (ordinary reconnect) and a collector fault whose
        // inventoryFault needs reserved close code 4502 as its fallback.
        console.error('[WS] Outbound buffer limit exceeded; authoritative inventory caller will retire the connection');
      } else {
        console.error('[WS] Outbound buffer limit exceeded; terminating stale connection');
        this.ws.terminate();
      }
      return false;
    }
    this.ws.send(encoded);
    if (msg.kind === 'hello') this.helloSentGeneration = this.socketGeneration;
    return true;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get connectionGeneration(): number {
    return this.socketGeneration;
  }

  /** Retire only the socket generation whose authoritative observation failed. */
  retireGeneration(expectedGeneration: number, code: number, reason: string): boolean {
    const socket = this.ws;
    if (
      !socket
      || socket.readyState !== WebSocket.OPEN
      || expectedGeneration !== this.socketGeneration
    ) return false;
    socket.close(code, reason);
    return true;
  }

  private connect(): void {
    if (this.stopped) return;

    console.log(`[WS] Connecting to ${this.options.url}...`);
    const socket = new WebSocket(this.options.url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
      maxPayload: MAX_AGENT_WS_FRAME_BYTES,
      perMessageDeflate: false,
    });
    this.ws = socket;
    let awaitingPong = false;
    let generation = 0;

    socket.on('open', () => {
      if (this.ws !== socket) return;
      generation = ++this.socketGeneration;
      this.helloSentGeneration = 0;
      this.admissionReadyGeneration = 0;
      console.log('[WS] Connected');
      this.reconnectDelay = 1000;
      this.startPingTimer(socket, () => awaitingPong, (value) => { awaitingPong = value; });
    });

    socket.on('message', async (raw) => {
      if (this.ws !== socket) return;
      try {
        const envelope = zEnvelope.parse(JSON.parse(raw.toString())) as BackendToAgentMessage;
        if (envelope.kind === 'admission.ready.v1') {
          const admission = zAdmissionReadyPayload.parse(envelope.payload);
          if (
            admission.serverId !== this.options.serverId
            || this.admissionReadyGeneration === generation
          ) {
            socket.terminate();
            return;
          }
          this.admissionReadyGeneration = generation;
          this.enqueueConnectionInitialization(socket, generation);
          return;
        }
        if (this.admissionReadyGeneration !== generation) {
          socket.terminate();
          return;
        }
        if (!this.messageHandler) return;
        await this.messageHandler(envelope);
      } catch (err) {
        console.error('[WS] Failed to handle message:', err);
      }
    });

    socket.on('pong', () => {
      if (this.ws === socket) awaitingPong = false;
    });

    socket.on('close', async (code, reason) => {
      if (this.ws !== socket) return;
      console.warn(`[WS] Disconnected: ${code} ${reason}`);
      this.clearPingTimer();
      this.ws = null;
      this.helloSentGeneration = 0;
      this.admissionReadyGeneration = 0;
      this.options.onDisconnect?.();
      if (!this.stopped) {
        await sleep(this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        this.connect();
      }
    });

    socket.on('error', (err) => {
      console.error('[WS] Error:', err.message);
    });
  }

  private startPingTimer(
    socket: WebSocket,
    isAwaitingPong: () => boolean,
    setAwaitingPong: (value: boolean) => void,
  ): void {
    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
      if (this.ws !== socket || socket.readyState !== WebSocket.OPEN) return;
      if (isAwaitingPong()) {
        console.error('[WS] Backend heartbeat deadline exceeded; terminating connection');
        socket.terminate();
        return;
      }
      setAwaitingPong(true);
      socket.ping();
    }, PING_INTERVAL_MS);
    // Don't prevent the process from exiting if only the ping timer is active
    this.pingTimer.unref?.();
  }

  /**
   * Keep physical connection initialization single-flight across reconnects.
   * A Docker mutation that reaches its hard deadline never settles and kills
   * the Agent, so a replacement socket cannot start an overlapping mutation.
   * If an older attempt does settle, only the current generation is observed
   * again before it can advertise hello.
   */
  private enqueueConnectionInitialization(socket: WebSocket, generation: number): void {
    if (this.activeConnectionInitialization) {
      // Only the latest reconnect matters. Older queued generations have no
      // socket on which they could safely advertise readiness.
      this.pendingConnectionInitialization = { socket, generation };
      return;
    }

    const drain = async () => {
      let next: { socket: WebSocket; generation: number } | null = { socket, generation };
      while (next) {
        await this.runConnectionInitialization(next.socket, next.generation);
        next = this.pendingConnectionInitialization;
        this.pendingConnectionInitialization = null;
      }
    };
    const active = Promise.resolve().then(drain).finally(() => {
      if (this.activeConnectionInitialization === active) {
        this.activeConnectionInitialization = null;
      }
      const pending = this.pendingConnectionInitialization;
      this.pendingConnectionInitialization = null;
      if (pending && !this.stopped) {
        this.enqueueConnectionInitialization(pending.socket, pending.generation);
      }
    });
    this.activeConnectionInitialization = active;
  }

  private async runConnectionInitialization(socket: WebSocket, generation: number): Promise<void> {
    if (
      this.stopped
      || this.ws !== socket
      || socket.readyState !== WebSocket.OPEN
      || generation !== this.socketGeneration
    ) return;
    try {
      await this.options.onConnect?.(generation);
    } catch (error) {
      console.error('[WS] onConnect error:', error);
      if (
        !this.stopped
        && this.ws === socket
        && socket.readyState === WebSocket.OPEN
        && generation === this.socketGeneration
      ) {
        socket.close(4501, 'Agent initialization failed');
      }
    }
  }

  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
