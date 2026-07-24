import { Injectable, Logger } from '@nestjs/common';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { JwtService } from '@nestjs/jwt';
import type { JwtPayload } from '../auth/auth.service.js';
import { AgentGateway } from './agent-gateway.js';
import { ExecSessionRegistry, type ExecSessionInfo } from './exec-session-registry.js';
import { ExecSessionAuthorizationService } from './exec-session-authorization.service.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';

type BrowserMessage =
  | { type: 'auth'; token: string }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

const MAX_CONSOLE_FRAME_BYTES = 128 * 1024;
const MAX_CONSOLE_INPUT_CHARS = 64 * 1024;
const MAX_CONSOLE_OUTBOUND_BUFFERED_BYTES = 256 * 1024;
const CONSOLE_AUTHORIZATION_RECHECK_MS = 1_000;
const CONSOLE_AUTH_TIMEOUT_MS = 10_000;
const MAX_INITIALIZING_CONSOLE_CONNECTIONS = 32;
const MAX_PENDING_BROWSER_FRAMES = 64;
const MAX_PENDING_BROWSER_BYTES = 128 * 1024;
export const MAX_CONCURRENT_CONSOLE_AUTH_CHECKS = 64;

@Injectable()
export class ConsoleGateway {
  private readonly logger = new Logger(ConsoleGateway.name);
  private readonly initializingSockets = new Set<WebSocket>();
  private activeAuthorizationChecks = 0;

  constructor(
    private readonly agentGateway: AgentGateway,
    private readonly sessionRegistry: ExecSessionRegistry,
    private readonly jwtService: JwtService,
    private readonly config: NyabaseConfigService,
    private readonly sessionAuthorization: ExecSessionAuthorizationService,
  ) {}

  attachToHttpServer(server: http.Server): void {
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_CONSOLE_FRAME_BYTES,
      perMessageDeflate: false,
    });
    server.on('upgrade', (req: http.IncomingMessage, socket, head) => {
      if (req.url?.split('?')[0] !== '/ws/console') return;
      try {
        wss.handleUpgrade(req, socket as import('stream').Duplex, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      } catch {
        socket.destroy();
      }
    });
    wss.on('connection', (ws, req) => {
      // Error/close handlers must exist before the first repository await.
      ws.on('error', (error) => {
        this.logger.warn(`Console WS error: ${error.message}`);
      });
      if (this.initializingSockets.size >= MAX_INITIALIZING_CONSOLE_CONNECTIONS) {
        ws.terminate();
        return;
      }
      this.initializingSockets.add(ws);
      const releaseInitializing = () => this.initializingSockets.delete(ws);
      void this.handleConnection(ws, req).catch((error) => {
        this.logger.warn(`Console setup failed: ${error instanceof Error ? error.message : String(error)}`);
        ws.terminate();
      }).finally(releaseInitializing);
    });
    this.logger.log('Console WebSocket gateway ready at /ws/console');
  }

  private async handleConnection(
    ws: WebSocket,
    req: http.IncomingMessage,
  ): Promise<void> {
    let url: URL;
    try {
      // A fixed base avoids trusting a malformed Host header during admission.
      url = new URL(req.url ?? '', 'http://localhost');
    } catch {
      ws.close(4400, 'Invalid console URL');
      return;
    }
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId) {
      ws.close(4001, 'Missing sessionId');
      return;
    }

    // Authentication via first message (token not in URL to avoid leaking into logs)
    await new Promise<void>((resolve) => {
      let settled = false;
      let authProcessing = false;
      const postAuthFrames: import('ws').RawData[] = [];
      let postAuthBytes = 0;
      const bufferDuringAuth = (raw: import('ws').RawData) => {
        const bytes = Buffer.byteLength(raw.toString());
        if (
          postAuthFrames.length >= MAX_PENDING_BROWSER_FRAMES
          || postAuthBytes + bytes > MAX_PENDING_BROWSER_BYTES
        ) {
          ws.close(4429, 'Console auth backlog exceeded');
          return;
        }
        postAuthFrames.push(raw);
        postAuthBytes += bytes;
      };
      const finishAdmission = () => {
        if (settled) return;
        settled = true;
        clearTimeout(authTimeout);
        ws.off('message', onFirstMessage);
        ws.off('message', bufferDuringAuth);
        ws.off('close', onPreAuthClose);
        resolve();
      };
      const authTimeout = setTimeout(() => {
        ws.close(4001, 'Auth timeout');
        if (!authProcessing) finishAdmission();
      }, CONSOLE_AUTH_TIMEOUT_MS);
      authTimeout.unref?.();

      // If an uncancellable repository check has started, transport close must
      // not release the admission slot. The async handler will finish the
      // reservation only after that query actually settles.
      const onPreAuthClose = () => {
        if (!authProcessing) finishAdmission();
      };

      const onFirstMessage = async (raw: import('ws').RawData) => {
        if (authProcessing || settled) return;
        authProcessing = true;
        ws.off('message', onFirstMessage);
        ws.on('message', bufferDuringAuth);

        let msg: BrowserMessage;
        try {
          msg = JSON.parse(raw.toString()) as BrowserMessage;
        } catch {
          ws.close(4400, 'Invalid JSON');
          return finishAdmission();
        }

        if (
          !msg
          || typeof msg !== 'object'
          || msg.type !== 'auth'
          || typeof msg.token !== 'string'
          || msg.token.length === 0
          || msg.token.length > 16 * 1024
        ) {
          ws.close(4001, 'Expected auth message');
          return finishAdmission();
        }

        // Validate JWT. Current user/capability/container authority is checked
        // against SQLite after the process-local session is atomically claimed.
        let jwtPayload: JwtPayload;
        try {
          jwtPayload = this.jwtService.verify<JwtPayload>(msg.token, {
            secret: this.config.get<string>('auth.jwtSecret'),
          });
          if (
            typeof jwtPayload.sub !== 'string'
            || jwtPayload.sub.length === 0
            || !Number.isInteger(jwtPayload.ver)
            || jwtPayload.ver < 0
            || !Number.isInteger(jwtPayload.exp)
            || jwtPayload.exp! <= 0
          ) {
            throw new Error('Invalid token claims');
          }
        } catch {
          ws.close(4003, 'Invalid token');
          return finishAdmission();
        }

        if (ws.readyState !== WebSocket.OPEN) return finishAdmission();

        let revokedByRegistry = false;
        // Ownership verification and claiming are one synchronous registry operation.
        const sessionInfo = this.sessionRegistry.claimForUser(
          sessionId,
          jwtPayload.sub,
          (reason) => {
            revokedByRegistry = true;
            if (ws.readyState === WebSocket.OPEN) ws.close(1012, reason.slice(0, 120));
            else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
          },
        );
        if (!sessionInfo) {
          // Unknown, already claimed, and wrong-owner sessions are deliberately indistinguishable.
          ws.close(4404, 'Unknown session');
          return finishAdmission();
        }

        // Claiming prevents a second browser from racing this uncancellable
        // authorization read. The initializing slot remains reserved until
        // the query settles even if the transport closes in the meantime.
        let initiallyAuthorized = false;
        try {
          initiallyAuthorized = await this.isSessionAuthorized(
            sessionInfo,
            jwtPayload.ver,
            jwtPayload.exp! * 1_000,
          );
        } catch {
          // Database/capacity failure is fail-closed for an interactive shell.
        }
        if (
          !initiallyAuthorized
          || ws.readyState !== WebSocket.OPEN
          || this.sessionRegistry.get(sessionId) !== sessionInfo
        ) {
          if (this.sessionRegistry.remove(sessionId, sessionInfo)) {
            try { this.agentGateway.notify(sessionInfo.serverId, 'execClose', { sessionId }); } catch { /* fenced */ }
          }
          if (ws.readyState === WebSocket.OPEN) ws.close(4403, 'Console authorization revoked');
          return finishAdmission();
        }

        const { serverId } = sessionInfo;
        finishAdmission();
        this.logger.log(`Console connected: session=${sessionId} server=${serverId} user=${jwtPayload.sub}`);

        // Once the agent has indicated EOF we no longer need to send execClose on WS close.
        let agentTerminated = false;
        let sessionClosed = false;
        let authorizationInFlight: Promise<boolean> | null = null;
        const revokeSession = (code: number, reason: string) => {
          if (sessionClosed) return;
          // Revoke the Agent process immediately; waiting for a WebSocket close
          // handshake would let an already-running shell outlive its authority.
          revokedByRegistry = true;
          if (this.sessionRegistry.remove(sessionId, sessionInfo)) {
            try { this.agentGateway.notify(serverId, 'execClose', { sessionId }); } catch { /* fenced */ }
          }
          if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
          else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        };
        const checkActiveAuthorization = (): Promise<boolean> => {
          if (authorizationInFlight) return authorizationInFlight;
          const check = this.sessionRegistry.get(sessionId) === sessionInfo
            ? this.isSessionAuthorized(sessionInfo, jwtPayload.ver, jwtPayload.exp! * 1_000)
            : Promise.resolve(false);
          const tracked = check.finally(() => {
            if (authorizationInFlight === tracked) authorizationInFlight = null;
          });
          authorizationInFlight = tracked;
          return tracked;
        };

        // Forward log chunks from agent to browser
        const safeSend = (message: unknown): boolean => {
          if (ws.readyState !== WebSocket.OPEN) return false;
          const encoded = JSON.stringify(message);
          if (
            Buffer.byteLength(encoded) > MAX_CONSOLE_FRAME_BYTES
            || ws.bufferedAmount + Buffer.byteLength(encoded) > MAX_CONSOLE_OUTBOUND_BUFFERED_BYTES
          ) {
            this.logger.warn(`Closing slow console consumer session=${sessionId}`);
            ws.terminate();
            return false;
          }
          ws.send(encoded);
          return true;
        };

        let offLog: () => void;
        try {
          offLog = this.agentGateway.onLogChunk(sessionId, serverId, (chunk) => {
            this.sessionRegistry.touch(sessionId);
            if (chunk.eof) agentTerminated = true;
            if (chunk.eof) {
              if (safeSend({ type: 'eof', exitCode: chunk.exitCode ?? 0 })) {
                ws.close(1000, 'Session ended');
              }
              return;
            }
            safeSend({ type: 'data', data: chunk.data, stderr: chunk.stderr });
          });
        } catch (error) {
          if (this.sessionRegistry.remove(sessionId, sessionInfo)) {
            try { this.agentGateway.notify(serverId, 'execClose', { sessionId }); } catch { /* already fenced */ }
          }
          this.logger.warn(`Aborting claimed console session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
          ws.close(4429, 'Console session limit reached');
          return;
        }

        // Forward subsequent browser messages to agent
        let browserMessageTail = Promise.resolve();
        let pendingBrowserFrames = 0;
        let pendingBrowserBytes = 0;
        const handleBrowserMessage = async (rawMsg: import('ws').RawData) => {
          if (sessionClosed || ws.readyState !== WebSocket.OPEN) return;
          let m: BrowserMessage;
          try {
            m = JSON.parse(rawMsg.toString()) as BrowserMessage;
          } catch {
            return;
          }
          if (
            !m
            || typeof m !== 'object'
            || (m.type === 'input' && (typeof m.data !== 'string' || m.data.length > MAX_CONSOLE_INPUT_CHARS))
            || (m.type === 'resize' && (
              !Number.isInteger(m.cols) || m.cols <= 0 || m.cols > 1_000
              || !Number.isInteger(m.rows) || m.rows <= 0 || m.rows > 1_000
            ))
            || (m.type !== 'input' && m.type !== 'resize')
          ) {
            ws.close(4400, 'Invalid console message');
            return;
          }
          if (!await checkActiveAuthorization()) {
            revokeSession(4403, 'Console authorization revoked');
            return;
          }
          if (sessionClosed || ws.readyState !== WebSocket.OPEN) return;
          this.sessionRegistry.touch(sessionId);
          this.agentGateway.touchLogSession(sessionId);
          if (m.type === 'input') {
            const encoded = Buffer.from(m.data, 'utf-8').toString('base64');
            this.agentGateway.notify(serverId, 'execInput', { sessionId, data: encoded });
          } else if (m.type === 'resize') {
            this.agentGateway.notify(serverId, 'execResize', { sessionId, cols: m.cols, rows: m.rows });
          }
        };
        const queueBrowserMessage = (rawMsg: import('ws').RawData) => {
          if (sessionClosed || ws.readyState !== WebSocket.OPEN) return;
          const frameBytes = Buffer.byteLength(rawMsg.toString());
          if (
            pendingBrowserFrames >= MAX_PENDING_BROWSER_FRAMES
            || pendingBrowserBytes + frameBytes > MAX_PENDING_BROWSER_BYTES
          ) {
            ws.close(4429, 'Console input backlog exceeded');
            return;
          }
          pendingBrowserFrames += 1;
          pendingBrowserBytes += frameBytes;
          browserMessageTail = browserMessageTail
            .then(() => handleBrowserMessage(rawMsg))
            .catch((error) => {
              this.logger.warn(`Console authorization check failed session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
              revokeSession(4403, 'Authorization check failed');
            })
            .finally(() => {
              pendingBrowserFrames -= 1;
              pendingBrowserBytes -= frameBytes;
            });
        };
        ws.on('message', queueBrowserMessage);
        for (const buffered of postAuthFrames) queueBrowserMessage(buffered);

        const authorizationTimer = setInterval(() => {
          if (sessionClosed || authorizationInFlight) return;
          void checkActiveAuthorization().then((active) => {
            if (!active) revokeSession(4403, 'Console authorization revoked');
          }, () => {
            revokeSession(1011, 'Authorization unavailable');
          });
        }, CONSOLE_AUTHORIZATION_RECHECK_MS);
        authorizationTimer.unref?.();

        ws.on('close', () => {
          sessionClosed = true;
          clearInterval(authorizationTimer);
          offLog();
          const removed = this.sessionRegistry.remove(sessionId, sessionInfo);
          // Only ask the agent to terminate if it hasn't already (to avoid noise).
          if (removed && !agentTerminated && !revokedByRegistry) {
            try { this.agentGateway.notify(serverId, 'execClose', { sessionId }); } catch { /* already fenced */ }
          }
          this.logger.log(`Console disconnected: session=${sessionId}`);
        });
      };

      ws.once('close', onPreAuthClose);
      ws.on('message', onFirstMessage);
    });
  }

  private async isSessionAuthorized(
    info: ExecSessionInfo,
    authVersion: number,
    tokenExpiresAtMs: number,
  ): Promise<boolean> {
    if (!Number.isFinite(tokenExpiresAtMs) || Date.now() >= tokenExpiresAtMs) return false;
    if (this.activeAuthorizationChecks >= MAX_CONCURRENT_CONSOLE_AUTH_CHECKS) {
      throw new Error('Console authorization capacity reached');
    }
    this.activeAuthorizationChecks += 1;
    try {
      return await this.sessionAuthorization.isAuthorized(info, authVersion);
    } finally {
      this.activeAuthorizationChecks -= 1;
    }
  }
}
