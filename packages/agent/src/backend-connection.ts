import WebSocket from 'ws';
import {
  AGENT_CLOSE_PROTOCOL_UNSUPPORTED,
  AGENT_HEARTBEAT_INTERVAL_MS,
  AGENT_PROTOCOL_VERSION,
  AGENT_STATUS_MIN_INTERVAL_MS,
  MAX_AGENT_BACKEND_FRAME_BYTES,
  zAgentBackendFrame,
  type AgentErrorCode,
  type AgentFirewallApplyResult,
  type AgentHello,
  type AgentHostStatus,
  type AgentIncusHttpParams,
  type AgentIncusHttpResult,
  type AgentIncusWebSocketParams,
  type AgentMetricsResult,
  type AgentRequest,
  type AgentResponse,
} from '@nyabase/common';

export class AgentRequestError extends Error {
  constructor(readonly code: AgentErrorCode, message: string) {
    super(message);
  }
}

export interface AgentHandlers {
  hello(): Promise<AgentHello>;
  incusHttp(params: AgentIncusHttpParams, signal: AbortSignal): Promise<AgentIncusHttpResult>;
  /**
   * `signal` cancels the request; `session` ends with the control connection
   * the request came on, and the bridged stream must not outlive it.
   */
  incusWebSocket(params: AgentIncusWebSocketParams, signal: AbortSignal, session: AbortSignal): Promise<void>;
  collectMetrics(signal: AbortSignal): Promise<AgentMetricsResult>;
  /** `firewall.apply`; `params` is whatever the frame carried, the handler validates it. */
  applyFirewall(params: unknown, signal: AbortSignal): Promise<AgentFirewallApplyResult>;
}

export interface BackendConnectionOptions {
  readonly url: string;
  readonly ca?: Buffer;
  readonly credential: () => string;
  readonly handlers: AgentHandlers;
  readonly log: (message: string) => void;
  /** Called when the Backend refuses the credential (close 4401). */
  readonly onCredentialRejected?: () => Promise<void>;
  readonly maxConcurrentRequests?: number;
  /** Current host status, sent after welcome and again on every publishStatus(). */
  readonly status?: () => AgentHostStatus;
  /** A control socket that was open closed (whether or not it was welcomed). */
  readonly onDisconnected?: () => void;
  /** Shortest gap between status frames on one connection (default AGENT_STATUS_MIN_INTERVAL_MS). */
  readonly statusIntervalMs?: number;
}

/** Close codes the Backend uses on the control socket. */
export const AGENT_CLOSE_CREDENTIAL_REJECTED = 4401;
export const AGENT_CLOSE_REPLACED = 4409;

interface SessionEnd {
  readonly code: number;
  readonly reason: string;
}

const WELCOME_TIMEOUT_MS = 10_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const REJECTED_BACKOFF_MS = 60_000;

/**
 * The agent's single control connection: dial, hello, then serve Backend
 * requests until the socket drops; reconnect with capped, jittered backoff.
 */
export class BackendConnection {
  private readonly inFlight = new Map<string, AbortController>();
  /** The control socket once the Backend welcomed it; unsolicited frames go only there. */
  private welcomedSocket: WebSocket | undefined;
  /** What the Backend last heard on the current socket (hello or status), and when a status frame went out. */
  private reported: { socket: WebSocket; status: string; sentAt: number; timer?: NodeJS.Timeout } | undefined;

  constructor(private readonly options: BackendConnectionOptions) {}

  /**
   * Tell the Backend the host status changed; a no-op while not connected
   * (hello carries it). At most one status frame per statusIntervalMs: changes
   * in between are coalesced into one trailing frame with the latest status,
   * and a status the Backend already has is not sent again.
   */
  publishStatus(): void {
    const socket = this.welcomedSocket;
    const reported = this.reported;
    if (!socket || socket.readyState !== WebSocket.OPEN || reported?.socket !== socket || reported.timer) return;
    const wait = reported.sentAt + (this.options.statusIntervalMs ?? AGENT_STATUS_MIN_INTERVAL_MS) - Date.now();
    if (wait > 0) {
      reported.timer = setTimeout(() => {
        reported.timer = undefined;
        this.publishStatus();
      }, wait);
      return;
    }
    const status = this.options.status?.();
    if (!status) return;
    const serialized = JSON.stringify(status);
    if (serialized === reported.status) return;
    socket.send(JSON.stringify({ type: 'status', status }));
    reported.status = serialized;
    reported.sentAt = Date.now();
  }

  async run(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      let closed: SessionEnd = { code: 0, reason: '' };
      const started = Date.now();
      try {
        closed = await this.session(signal);
      } catch (error) {
        this.options.log(`control connection failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (signal.aborted) return;
      if (Date.now() - started > MAX_BACKOFF_MS) attempt = 0;
      let delay = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** attempt);
      attempt += 1;
      if (closed.code === AGENT_CLOSE_CREDENTIAL_REJECTED) {
        this.options.log('Backend rejected the agent credential');
        await this.options.onCredentialRejected?.();
        delay = REJECTED_BACKOFF_MS;
      } else if (closed.code === AGENT_CLOSE_PROTOCOL_UNSUPPORTED) {
        // Retrying cannot help until one side is upgraded; stay visible but quiet.
        this.options.log(`Backend refused agent protocol ${AGENT_PROTOCOL_VERSION}: ${closed.reason || 'no reason given'}`);
        delay = REJECTED_BACKOFF_MS;
      } else if (closed.code !== 0 && closed.code !== 1000 && closed.code !== 1001) {
        this.options.log(`control connection closed (${closed.code}${closed.reason ? ` ${closed.reason}` : ''})`);
      }
      await sleep(delay / 2 + Math.random() * (delay / 2), signal);
    }
  }

  /** One connected session; resolves with how it was closed. */
  private session(signal: AbortSignal): Promise<SessionEnd> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.options.url, {
        headers: { authorization: `Bearer ${this.options.credential()}` },
        ca: this.options.ca,
        handshakeTimeout: WELCOME_TIMEOUT_MS,
        maxPayload: MAX_AGENT_BACKEND_FRAME_BYTES,
        perMessageDeflate: false,
      });
      let welcomed = false;
      let alive = true;
      const session = new AbortController();
      const welcomeTimer = setTimeout(() => socket.terminate(), WELCOME_TIMEOUT_MS);
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, AGENT_HEARTBEAT_INTERVAL_MS);
      const abort = (): void => socket.close(1001, 'agent stopping');
      signal.addEventListener('abort', abort, { once: true });
      socket.on('pong', () => {
        alive = true;
      });
      socket.on('ping', () => {
        alive = true;
      });
      socket.once('open', () => {
        void this.options.handlers.hello()
          .then((hello) => {
            this.reported = { socket, status: JSON.stringify(hello.status), sentAt: 0 };
            socket.send(JSON.stringify(hello));
          })
          .catch((error: unknown) => {
            this.options.log(`hello failed: ${error instanceof Error ? error.message : String(error)}`);
            socket.close(1011, 'hello failed');
          });
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          socket.close(1003, 'binary control frame');
          return;
        }
        let frame;
        try {
          frame = zAgentBackendFrame.parse(JSON.parse(data.toString()));
        } catch {
          socket.close(1008, 'malformed control frame');
          return;
        }
        if (frame.type === 'welcome') {
          welcomed = true;
          clearTimeout(welcomeTimer);
          this.welcomedSocket = socket;
          this.options.log(`connected to Backend as server ${frame.serverId}`);
          // The status may have changed between hello and welcome.
          this.publishStatus();
          return;
        }
        if (!welcomed) {
          socket.close(1008, 'request before welcome');
          return;
        }
        if (frame.type === 'cancel') {
          this.inFlight.get(frame.id)?.abort();
          return;
        }
        this.serve(socket, frame, session.signal);
      });
      socket.once('unexpected-response', (_request, response) => {
        const code = response.statusCode === 401 || response.statusCode === 403
          ? AGENT_CLOSE_CREDENTIAL_REJECTED
          : 0;
        socket.terminate();
        cleanup();
        resolve({ code, reason: '' });
      });
      let opened = false;
      socket.once('open', () => {
        opened = true;
      });
      const cleanup = (): void => {
        if (this.welcomedSocket === socket) this.welcomedSocket = undefined;
        if (this.reported?.socket === socket) {
          clearTimeout(this.reported.timer);
          this.reported = undefined;
        }
        if (opened) {
          opened = false;
          this.options.onDisconnected?.();
        }
        clearTimeout(welcomeTimer);
        clearInterval(heartbeat);
        signal.removeEventListener('abort', abort);
        session.abort();
        for (const controller of this.inFlight.values()) controller.abort();
        this.inFlight.clear();
      };
      socket.once('close', (code, reason) => {
        cleanup();
        resolve({ code, reason: reason.toString('utf8').slice(0, 200) });
      });
      socket.once('error', (error) => {
        cleanup();
        reject(error);
      });
    });
  }

  private serve(socket: WebSocket, request: AgentRequest, session: AbortSignal): void {
    const limit = this.options.maxConcurrentRequests ?? 256;
    if (this.inFlight.has(request.id)) return;
    if (this.inFlight.size >= limit) {
      send(socket, failure(request.id, 'internal', 'agent is at its concurrent request limit'));
      return;
    }
    const controller = new AbortController();
    this.inFlight.set(request.id, controller);
    void this.dispatch(request, controller.signal, session)
      .then((result) => send(socket, { type: 'response', id: request.id, ok: true, result }))
      .catch((error: unknown) => {
        if (error instanceof AgentRequestError) {
          send(socket, failure(request.id, error.code, error.message));
          return;
        }
        send(socket, failure(request.id, 'internal', error instanceof Error ? error.message : String(error)));
      })
      .finally(() => this.inFlight.delete(request.id));
  }

  private dispatch(request: AgentRequest, signal: AbortSignal, session: AbortSignal): Promise<unknown> {
    switch (request.method) {
      case 'incus.http':
        return this.options.handlers.incusHttp(request.params, signal);
      case 'incus.ws':
        return this.options.handlers.incusWebSocket(request.params, signal, session).then(() => ({}));
      case 'metrics.collect':
        return this.options.handlers.collectMetrics(signal);
      case 'firewall.apply':
        return this.options.handlers.applyFirewall(request.params, signal);
    }
  }
}

function failure(id: string, code: AgentErrorCode, message: string): AgentResponse {
  return { type: 'response', id, ok: false, error: { code, message: message.slice(0, 1024) } };
}

function send(socket: WebSocket, frame: AgentResponse): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(frame));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
