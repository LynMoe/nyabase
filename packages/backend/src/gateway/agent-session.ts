import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { AgentCommandEnvelope, BackendToAgentMessage, Envelope } from '@nyabase/common';

interface PendingRpc {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AgentSession {
  readonly id: string = uuidv4();
  readonly serverId: string;
  readonly ws: WebSocket;
  private pending: Map<string, PendingRpc> = new Map();

  constructor(serverId: string, ws: WebSocket) {
    this.serverId = serverId;
    this.ws = ws;
  }

  send(message: BackendToAgentMessage) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /** Send a command and wait for commandAck with matching id */
  async rpc<T>(
    kind: BackendToAgentMessage['kind'],
    payload: unknown,
    timeoutMs = 30_000,
  ): Promise<T> {
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

      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(envelope));
      } else {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Agent not connected'));
      }
    });
  }

  async commandEnvelope<T>(
    envelope: AgentCommandEnvelope,
    timeoutMs = 60_000,
  ): Promise<T> {
    const id = envelope.commandId;
    const message: Envelope<'agentCommand', AgentCommandEnvelope> = {
      id,
      ts: Date.now(),
      kind: 'agentCommand',
      payload: envelope,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent command timeout: ${envelope.commandKind} (commandId=${id})`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (data) => resolve(data as T),
        reject,
        timer,
      });

      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(message));
      } else {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Agent offline'));
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
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
