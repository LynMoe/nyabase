import { Injectable, Logger } from '@nestjs/common';
import type { AgentHello } from '@nyabase/common';
import { AgentConnection, AgentStreamBroker } from './agent-connection.js';
import { IncusError } from './incus-errors.js';
import type { IncusTunnel } from './incus-client-types.js';

export interface AgentPresenceListener {
  connected(serverId: string, hello: AgentHello): void | Promise<void>;
  disconnected(serverId: string): void | Promise<void>;
}

/** Close codes the Backend sends on agent control sockets. */
export const AGENT_CLOSE_CREDENTIAL_REJECTED = 4401;
export const AGENT_CLOSE_REPLACED = 4409;

/**
 * The connected host agents, one control connection per server. Every Incus
 * call resolves the server's current connection when it is made, so clients
 * and event streams survive agent reconnects.
 */
@Injectable()
export class AgentRegistry {
  private readonly logger = new Logger(AgentRegistry.name);
  private readonly connections = new Map<string, AgentConnection>();
  private readonly listeners = new Set<AgentPresenceListener>();
  readonly streams = new AgentStreamBroker();

  register(connection: AgentConnection): void {
    const previous = this.connections.get(connection.serverId);
    this.connections.set(connection.serverId, connection);
    if (previous && previous !== connection) {
      previous.close(AGENT_CLOSE_REPLACED, 'replaced by a newer agent connection');
    }
    this.notify((listener) => listener.connected(connection.serverId, connection.hello));
  }

  unregister(connection: AgentConnection): void {
    connection.markClosed();
    if (this.connections.get(connection.serverId) !== connection) return;
    this.connections.delete(connection.serverId);
    this.notify((listener) => listener.disconnected(connection.serverId));
  }

  /** Drop the server's agent, e.g. after its credential was replaced or the server deleted. */
  disconnect(serverId: string, code = AGENT_CLOSE_CREDENTIAL_REJECTED, reason = 'credential revoked'): void {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    connection.close(code, reason);
    this.unregister(connection);
  }

  current(serverId: string): AgentConnection | undefined {
    const connection = this.connections.get(serverId);
    return connection?.isOpen ? connection : undefined;
  }

  require(serverId: string): AgentConnection {
    const connection = this.current(serverId);
    if (!connection) {
      throw new IncusError('SERVER_UNREACHABLE', 'retry', { serverId, reason: 'agent_disconnected' });
    }
    return connection;
  }

  isConnected(serverId: string): boolean {
    return this.current(serverId) !== undefined;
  }

  connectedServerIds(): string[] {
    return [...this.connections.keys()].filter((serverId) => this.isConnected(serverId));
  }

  /** A tunnel bound to the server, not to one connection. */
  tunnel(serverId: string): IncusTunnel {
    return {
      request: async (request) => this.require(serverId).request(request),
      openWebSocket: async (path, signal) => this.require(serverId).openWebSocket(path, signal),
    };
  }

  onPresence(listener: AgentPresenceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(call: (listener: AgentPresenceListener) => void | Promise<void>): void {
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(call(listener)).catch((error: unknown) => {
          this.logger.warn(`Agent presence listener failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      } catch (error) {
        this.logger.warn(`Agent presence listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
