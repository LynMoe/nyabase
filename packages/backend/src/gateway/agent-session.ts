import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import {
  BackendToAgentMessage,
  Envelope,
  MAX_AGENT_WS_FRAME_BYTES,
  type DirectRpcKind,
} from '@nyabase/common';
import { performance } from 'node:perf_hooks';

interface PendingRpc {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Agent task/bootstrap frames are bounded to 1 MiB in normal operation. Keep
// enough headroom for one queued frame without allowing all platform Agents
// to retain an 8 MiB WebSocket buffer each.
export const MAX_AGENT_SESSION_BUFFERED_BYTES = 2 * 1024 * 1024;
export const MAX_AGENT_SESSION_PENDING_RPCS = 64;

/**
 * The RPC did not receive an Agent-authored response. Callers may retire and
 * reconnect the socket, but must not interpret this as negative inventory or
 * task evidence.
 */
export class AgentRpcTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRpcTransportError';
  }
}

export class AgentSession {
  readonly id: string = uuidv4();
  readonly serverId: string;
  readonly ws: WebSocket;
  private pending: Map<string, PendingRpc> = new Map();
  private helloReceived = false;
  private bootstrapReadyAt: number | null = null;
  private taskDispatchReady = false;
  private lastInboundAt = performance.now();
  private lastFullReportReceivedAt: number | null = null;
  private readonly lastReportSequence = new Map<'state', number>();

  constructor(serverId: string, ws: WebSocket) {
    this.serverId = serverId;
    this.ws = ws;
  }

  get dispatchReady(): boolean {
    return this.taskDispatchReady;
  }

  beginHello(): boolean {
    if (this.helloReceived) return false;
    this.helloReceived = true;
    return true;
  }

  get hasReceivedHello(): boolean {
    return this.helloReceived;
  }

  markInbound(now = performance.now()): void {
    this.lastInboundAt = now;
  }

  inboundExpired(now: number, activeTimeoutMs: number, preHelloTimeoutMs = activeTimeoutMs): boolean {
    const timeoutMs = this.helloReceived ? activeTimeoutMs : preHelloTimeoutMs;
    return now - this.lastInboundAt > timeoutMs;
  }

  acceptReportSequence(kind: 'state', sequence: number): boolean {
    const previous = this.lastReportSequence.get(kind);
    if (previous !== undefined && sequence <= previous) return false;
    this.lastReportSequence.set(kind, sequence);
    return true;
  }

  markDispatchReady(): void {
    this.taskDispatchReady = true;
  }

  markBootstrapReady(now = performance.now()): void {
    this.bootstrapReadyAt = now;
  }

  get bootstrapReady(): boolean {
    return this.bootstrapReadyAt !== null;
  }

  initializationExpired(now: number, timeoutMs: number): boolean {
    return !this.taskDispatchReady
      && this.bootstrapReadyAt !== null
      && now - this.bootstrapReadyAt > timeoutMs;
  }

  markFullReportReceived(now = performance.now()): void {
    this.lastFullReportReceivedAt = now;
  }

  fullReportExpired(now: number, timeoutMs: number): boolean {
    return this.taskDispatchReady
      && (this.lastFullReportReceivedAt === null
        || now - this.lastFullReportReceivedAt > timeoutMs);
  }

  send(message: BackendToAgentMessage): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    const encoded = JSON.stringify(message);
    const encodedBytes = Buffer.byteLength(encoded);
    if (
      encodedBytes > MAX_AGENT_WS_FRAME_BYTES
      || this.ws.bufferedAmount + encodedBytes > MAX_AGENT_SESSION_BUFFERED_BYTES
    ) {
      this.rejectAll('Agent connection exceeded the outbound backpressure limit');
      this.ws.terminate();
      return false;
    }
    this.ws.send(encoded);
    return true;
  }

  /** Send a command and wait for commandAck with matching id */
  async rpc<T>(
    kind: DirectRpcKind,
    payload: unknown,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.pending.size >= MAX_AGENT_SESSION_PENDING_RPCS) {
      throw new Error(`Agent RPC limit (${MAX_AGENT_SESSION_PENDING_RPCS}) reached`);
    }
    const id = uuidv4();
    const envelope: Envelope = { id, ts: Date.now(), kind, payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent RPC timeout: ${kind} (id=${id})`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (data) => resolve(data as T),
        reject,
        timer,
      });

      if (!this.send(envelope as BackendToAgentMessage)) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AgentRpcTransportError('Agent not connected or outbound buffer is full'));
      }
    });
  }

  resolveAck(commandId: string, ok: boolean, error?: string, data?: unknown) {
    const pending = this.pending.get(commandId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(commandId);
    if (ok) {
      pending.resolve(data);
    } else {
      pending.reject(new Error(error ?? 'Agent command failed'));
    }
  }

  rejectAll(reason: string) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new AgentRpcTransportError(reason));
      this.pending.delete(id);
    }
  }
}
