import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  AGENT_STREAM_CONNECT_TIMEOUT_MS,
  MAX_AGENT_STATUS_FRAME_BYTES,
  MAX_AGENT_STATUS_FRAMES_PER_MINUTE,
  zAgentFirewallApplyResult,
  zAgentIncusHttpResult,
  zAgentMetricsResult,
  zAgentResponse,
  zAgentStatus,
  type AgentErrorCode,
  type AgentHello,
  type AgentHostStatus,
  type AgentRequest,
  type FirewallDocument,
} from '@nyabase/common';
import { isRecord } from '../platform/domain-utils.js';
import { IncusError } from './incus-errors.js';
import { BufferedStreamSocket, isOpen } from './agent-stream-socket.js';
import type {
  IncusTunnelRequest,
  IncusTunnelResponse,
  IncusWebSocketLike,
} from './incus-client-types.js';

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
  readonly cleanup: () => void;
}

/** The control connection a stream belongs to; streams live and die with it. */
export interface StreamOwner {
  readonly serverId: string;
  readonly isOpen: boolean;
  adopt(socket: WebSocket): void;
}

interface PendingStream {
  readonly owner: StreamOwner;
  readonly resolve: (socket: BufferedStreamSocket) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
  /** Drops the caller's abort listener; its signal may outlive many streams. */
  readonly detach: () => void;
}

/**
 * The agent answers incus.ws only after dialing Incus and then the Backend
 * (each bounded by AGENT_STREAM_CONNECT_TIMEOUT_MS), so the reply may take
 * twice that. The stream wait outlasts the reply wait: it is only a backstop
 * for a reply that arrived without its stream.
 */
export const AGENT_STREAM_REPLY_TIMEOUT_MS = AGENT_STREAM_CONNECT_TIMEOUT_MS * 2;
export const AGENT_STREAM_WAIT_TIMEOUT_MS = AGENT_STREAM_REPLY_TIMEOUT_MS + 5_000;

/** `firewall.apply` persists, checks and loads an nft table; bounded generously. */
export const AGENT_FIREWALL_APPLY_TIMEOUT_MS = 30_000;

/**
 * Requests given up on (timeout, abort) whose reply may still arrive. A
 * reply to anything else was never asked for and ends the connection.
 */
const MAX_ABANDONED_REQUESTS = 1_024;
const ABANDONED_REQUEST_TTL_MS = 10 * 60_000;

/** Hands agent-opened stream sockets to the Backend request waiting for them. */
export class AgentStreamBroker {
  private readonly pending = new Map<string, PendingStream>();

  expect(
    owner: StreamOwner,
    signal?: AbortSignal,
  ): { readonly streamId: string; readonly socket: Promise<BufferedStreamSocket> } {
    const streamId = randomUUID();
    const socket = new Promise<BufferedStreamSocket>((resolve, reject) => {
      const abort = (): void => this.fail(streamId, new IncusError('INCUS_TIMEOUT', 'retry', {
        phase: 'connect',
        reason: 'aborted',
      }));
      const detach = (): void => signal?.removeEventListener('abort', abort);
      const timer = setTimeout(() => {
        this.fail(streamId, new IncusError('INCUS_TIMEOUT', 'retry', { phase: 'connect', reason: 'agent_stream_timeout' }));
      }, AGENT_STREAM_WAIT_TIMEOUT_MS);
      this.pending.set(streamId, { owner, resolve, reject, timer, detach });
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
    // The caller awaits the incus.ws reply before it looks at the stream, and
    // the stream may fail (timeout, abort) meanwhile: an unobserved rejection
    // would take the process down. Awaiting `socket` still sees the error.
    void socket.catch(() => undefined);
    return { streamId, socket };
  }

  /**
   * Claim a pending stream for an authenticated agent; false when nobody waits
   * for it on a live connection of that server. Frames start buffering at once.
   */
  accept(streamId: string, serverId: string, socket: WebSocket): boolean {
    const pending = this.pending.get(streamId);
    if (!pending || pending.owner.serverId !== serverId || !pending.owner.isOpen) return false;
    this.pending.delete(streamId);
    clearTimeout(pending.timer);
    pending.detach();
    pending.owner.adopt(socket);
    pending.resolve(new BufferedStreamSocket(socket));
    return true;
  }

  /** Streams still waiting for their agent socket (for tests and diagnostics). */
  get pendingCount(): number {
    return this.pending.size;
  }

  fail(streamId: string, error: unknown): void {
    const pending = this.pending.get(streamId);
    if (!pending) return;
    this.pending.delete(streamId);
    clearTimeout(pending.timer);
    pending.detach();
    pending.reject(error);
  }
}

function agentFailure(code: AgentErrorCode, message: string): IncusError {
  switch (code) {
    case 'policy_denied':
      return new IncusError('AGENT_POLICY_DENIED', 'managed_failure', { message });
    case 'bad_request':
      return new IncusError('INCUS_BAD_REQUEST', 'managed_failure', { reason: 'agent', message });
    case 'timeout':
      return new IncusError('INCUS_TIMEOUT', 'retry', { phase: 'total', reason: 'agent' });
    case 'cancelled':
      return new IncusError('INCUS_TIMEOUT', 'retry', { phase: 'total', reason: 'cancelled' });
    case 'too_large':
      return new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', { reason: 'body_too_large' });
    case 'incus_unavailable':
      return new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'agent_incus_unavailable', message });
    case 'ipv6_guard_missing':
      // The host heals the guard itself (and reports it); the start waits for it.
      return new IncusError('AGENT_IPV6_GUARD_MISSING', 'retry', { message });
    case 'firewall_missing':
      // Same for the egress firewall: the Backend pushes the rules, the agent reports them in place.
      return new IncusError('AGENT_FIREWALL_MISSING', 'retry', { message });
    case 'internal':
      // A busy or failing agent request is retried; it says nothing about the server being down.
      return new IncusError('AGENT_REQUEST_FAILED', 'retry', { message });
  }
}

/** The control socket of one connected host agent: request/response RPC plus stream setup. */
export class AgentConnection implements StreamOwner {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly streams = new Set<WebSocket>();
  private closed = false;
  private hostStatus: AgentHostStatus;
  /** id -> when it was given up; insertion order is age order. */
  private readonly abandoned = new Map<string, number>();
  private statusWindow = { startedAt: 0, count: 0 };

  constructor(
    readonly serverId: string,
    readonly hello: AgentHello,
    private readonly socket: WebSocket,
    private readonly broker: AgentStreamBroker,
    /** Told after the agent reported a changed host status. */
    private readonly onStatus: (connection: AgentConnection) => void = () => undefined,
  ) {
    this.hostStatus = hello.status;
  }

  /** What the agent last reported about its host (IPv6 guard). */
  get status(): AgentHostStatus {
    return this.hostStatus;
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === WebSocket.OPEN;
  }

  async request(request: IncusTunnelRequest): Promise<IncusTunnelResponse> {
    const result = parseAgentResult(zAgentIncusHttpResult, 'incus.http', await this.call('incus.http', {
      method: request.method,
      path: request.path,
      headers: request.headers,
      ...(request.body ? { body: request.body.toString('base64') } : {}),
      timeoutMs: request.timeoutMs,
    }, request.timeoutMs + 2_000, request.signal));
    return { status: result.status, headers: result.headers, body: Buffer.from(result.body, 'base64') };
  }

  async openWebSocket(path: string, signal?: AbortSignal): Promise<IncusWebSocketLike> {
    const { streamId, socket } = this.broker.expect(this, signal);
    try {
      await this.call('incus.ws', { path, streamId }, AGENT_STREAM_REPLY_TIMEOUT_MS, signal);
    } catch (error) {
      this.broker.fail(streamId, error);
      // The agent may have connected the stream before its reply was lost or late.
      (await socket.catch(() => undefined))?.terminate();
      throw error;
    }
    return socket;
  }

  adopt(socket: WebSocket): void {
    if (this.closed) {
      socket.terminate();
      return;
    }
    this.streams.add(socket);
    socket.once('close', () => this.streams.delete(socket));
  }

  async collectMetrics(timeoutMs: number, signal?: AbortSignal): Promise<string> {
    return parseAgentResult(zAgentMetricsResult, 'metrics.collect', await this.call('metrics.collect', {}, timeoutMs, signal)).text;
  }

  /**
   * Replace the agent's egress firewall document; resolves with the digest the
   * agent applied. A document it refuses rejects with INCUS_BAD_REQUEST.
   */
  async applyFirewall(document: FirewallDocument, signal?: AbortSignal): Promise<string> {
    return parseAgentResult(
      zAgentFirewallApplyResult,
      'firewall.apply',
      await this.call('firewall.apply', document, AGENT_FIREWALL_APPLY_TIMEOUT_MS, signal),
    ).digest;
  }

  /**
   * Checked before a frame is parsed: an agent sends large frames only to
   * answer requests, so with nothing outstanding only a status frame fits.
   * One host cannot make the Backend parse more than it asked for.
   */
  admits(bytes: number): boolean {
    if (bytes <= MAX_AGENT_STATUS_FRAME_BYTES) return true;
    this.pruneAbandoned();
    return this.pending.size > 0 || this.abandoned.size > 0;
  }

  /** Route one agent frame that is not hello; returns false for a protocol violation. */
  handleFrame(raw: unknown): boolean {
    if (isRecord(raw) && raw.type === 'status') {
      const status = zAgentStatus.safeParse(raw);
      if (!status.success || !this.countStatusFrame()) return false;
      this.hostStatus = status.data.status;
      this.onStatus(this);
      return true;
    }
    const parsed = zAgentResponse.safeParse(raw);
    if (!parsed.success) return false;
    const frame = parsed.data;
    const pending = this.pending.get(frame.id);
    // A late reply to a request given up on is dropped; any other is unsolicited.
    if (!pending) return this.abandoned.delete(frame.id);
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    pending.cleanup();
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(agentFailure(frame.error.code, frame.error.message));
    return true;
  }

  close(code: number, reason: string): void {
    this.markClosed();
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(code, reason);
    }
  }

  /** Fail every request still waiting on this socket and drop its streams. */
  markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stream of this.streams) {
      if (isOpen(stream)) stream.close(1001, 'agent control connection closed');
      else stream.terminate();
    }
    this.streams.clear();
    this.abandoned.clear();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'agent_disconnected' }));
      this.pending.delete(id);
    }
  }

  private call(
    method: AgentRequest['method'],
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.isOpen) {
      return Promise.reject(new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'agent_disconnected' }));
    }
    if (signal?.aborted) {
      return Promise.reject(new IncusError('INCUS_TIMEOUT', 'retry', { phase: 'total', reason: 'aborted' }));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        this.abandon(id);
        this.send({ type: 'cancel', id });
        reject(new IncusError('INCUS_TIMEOUT', 'retry', { phase: 'total', reason: 'aborted' }));
      };
      const cleanup = (): void => signal?.removeEventListener('abort', abort);
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        cleanup();
        this.abandon(id);
        this.send({ type: 'cancel', id });
        reject(new IncusError('INCUS_TIMEOUT', 'retry', { phase: 'total', reason: 'agent_response_timeout' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      this.send({ type: 'request', id, method, params });
    });
  }

  private abandon(id: string): void {
    this.pruneAbandoned();
    while (this.abandoned.size >= MAX_ABANDONED_REQUESTS) {
      const oldest = this.abandoned.keys().next().value;
      if (oldest === undefined) break;
      this.abandoned.delete(oldest);
    }
    this.abandoned.set(id, Date.now());
  }

  private pruneAbandoned(): void {
    const cutoff = Date.now() - ABANDONED_REQUEST_TTL_MS;
    for (const [id, abandonedAt] of this.abandoned) {
      if (abandonedAt > cutoff) return;
      this.abandoned.delete(id);
    }
  }

  /** The agent reports status on change only; a stream of them is abuse. */
  private countStatusFrame(): boolean {
    const now = Date.now();
    if (now - this.statusWindow.startedAt >= 60_000) this.statusWindow = { startedAt: now, count: 0 };
    this.statusWindow.count += 1;
    return this.statusWindow.count <= MAX_AGENT_STATUS_FRAMES_PER_MINUTE;
  }

  private send(frame: Record<string, unknown>): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }
}

/**
 * A malformed agent reply is an upstream fault, not the caller's input: a raw
 * ZodError would reach the global filter and answer 400 INVALID_INPUT with
 * internal schema paths.
 */
function parseAgentResult<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, call: string, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', { reason: 'agent_result', call });
  return parsed.data;
}
