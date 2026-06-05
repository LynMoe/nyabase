import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { JwtService } from '@nestjs/jwt';
import type { JwtPayload } from '../auth/auth.service.js';
import { AgentGateway } from './agent-gateway.js';
import { ExecSessionRegistry } from './exec-session-registry.js';

type BrowserMessage =
  | { type: 'auth'; token: string }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

@Injectable()
export class ConsoleGateway {
  private readonly logger = new Logger(ConsoleGateway.name);

  constructor(
    private readonly agentGateway: AgentGateway,
    private readonly sessionRegistry: ExecSessionRegistry,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  attachToHttpServer(server: http.Server): void {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req: http.IncomingMessage, socket, head) => {
      if (req.url?.split('?')[0] !== '/ws/console') return;
      wss.handleUpgrade(req, socket as import('stream').Duplex, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
    wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    this.logger.log('Console WebSocket gateway ready at /ws/console');
  }

  private async handleConnection(ws: WebSocket, req: http.IncomingMessage): Promise<void> {
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId) {
      ws.close(4001, 'Missing sessionId');
      return;
    }

    // Helper: kill the agent-side exec for an unclaimed session whose WS handshake failed.
    // The session is registered and the agent already started exec, so refusing the WS
    // without notifying the agent would leak a zombie.
    const abortAgentSession = (reason: string) => {
      const info = this.sessionRegistry.get(sessionId);
      if (!info) return;
      this.sessionRegistry.remove(sessionId);
      this.agentGateway.notify(info.serverId, 'execClose', { sessionId });
      this.logger.warn(`Aborting agent exec session=${sessionId}: ${reason}`);
    };

    // Authentication via first message (token not in URL to avoid leaking into logs)
    await new Promise<void>((resolve) => {
      const authTimeout = setTimeout(() => {
        abortAgentSession('auth timeout');
        ws.close(4001, 'Auth timeout');
        resolve();
      }, 10_000);

      const onFirstMessage = async (raw: import('ws').RawData) => {
        clearTimeout(authTimeout);
        ws.off('message', onFirstMessage);

        let msg: BrowserMessage;
        try {
          msg = JSON.parse(raw.toString()) as BrowserMessage;
        } catch {
          abortAgentSession('invalid JSON in auth frame');
          ws.close(4400, 'Invalid JSON');
          return resolve();
        }

        if (msg.type !== 'auth') {
          abortAgentSession('first frame was not auth');
          ws.close(4001, 'Expected auth message');
          return resolve();
        }

        // Validate JWT
        let jwtPayload: JwtPayload;
        try {
          jwtPayload = this.jwtService.verify<JwtPayload>(msg.token, {
            secret: this.config.get<string>('app.jwtSecret'),
          });
        } catch {
          abortAgentSession('invalid token');
          ws.close(4003, 'Invalid token');
          return resolve();
        }

        // Look up the exec session and atomically claim it (cancels TTL).
        const sessionInfo = this.sessionRegistry.claim(sessionId);
        if (!sessionInfo) {
          // Could be unknown OR already-expired; either way nothing to clean up.
          ws.close(4404, 'Unknown session');
          return resolve();
        }

        if (sessionInfo.userId !== jwtPayload.sub) {
          abortAgentSession('user mismatch');
          ws.close(4403, 'Forbidden');
          return resolve();
        }

        const { serverId } = sessionInfo;
        this.logger.log(`Console connected: session=${sessionId} server=${serverId} user=${jwtPayload.sub}`);

        // Once the agent has indicated EOF we no longer need to send execClose on WS close.
        let agentTerminated = false;

        // Forward log chunks from agent to browser
        const offLog = this.agentGateway.onLogChunk(sessionId, serverId, (chunk) => {
          if (chunk.eof) agentTerminated = true;
          if (ws.readyState !== WebSocket.OPEN) return;
          if (chunk.eof) {
            ws.send(JSON.stringify({ type: 'eof', exitCode: chunk.exitCode ?? 0 }));
            ws.close(1000, 'Session ended');
            return;
          }
          ws.send(JSON.stringify({ type: 'data', data: chunk.data, stderr: chunk.stderr }));
        });

        // Forward subsequent browser messages to agent
        ws.on('message', (rawMsg) => {
          let m: BrowserMessage;
          try {
            m = JSON.parse(rawMsg.toString()) as BrowserMessage;
          } catch {
            return;
          }
          if (m.type === 'input') {
            const encoded = Buffer.from(m.data, 'utf-8').toString('base64');
            this.agentGateway.notify(serverId, 'execInput', { sessionId, data: encoded });
          } else if (m.type === 'resize') {
            this.agentGateway.notify(serverId, 'execResize', { sessionId, cols: m.cols, rows: m.rows });
          }
        });

        ws.on('close', () => {
          offLog();
          this.sessionRegistry.remove(sessionId);
          // Only ask the agent to terminate if it hasn't already (to avoid noise).
          if (!agentTerminated) {
            this.agentGateway.notify(serverId, 'execClose', { sessionId });
          }
          this.logger.log(`Console disconnected: session=${sessionId}`);
        });

        resolve();
      };

      ws.on('message', onFirstMessage);
    });

    ws.on('error', (err) => {
      this.logger.error(`Console WS error [session=${sessionId}]: ${err.message}`);
    });
  }
}
