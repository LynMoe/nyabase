import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type {
  FirewallDocument,
  FirewallServerStatusDto,
  FirewallSyncState,
  ServerAgentDto,
} from '@nyabase/common';
import type { AgentConnection } from '../incus/agent-connection.js';
import { AgentRegistry } from '../incus/agent-registry.service.js';
import { IncusError } from '../incus/incus-errors.js';
import { firewallDocuments } from './firewall-document.js';
import { FirewallRepository } from './firewall.repository.js';

export const FIREWALL_RETRY_INITIAL_MS = 5_000;
export const FIREWALL_RETRY_MAX_MS = 5 * 60_000;

/**
 * Why a sync runs. `status`: the agent reported a digest; push only when it
 * differs from the desired one (and is not the one the agent refused).
 * `push`: rules changed, the agent connected, or a retry is due; push unless
 * this connection already confirmed the desired document.
 */
type SyncReason = 'push' | 'status';

/** What this process knows about one connected agent's firewall; dropped with the connection. */
interface ServerSync {
  readonly connection: AgentConnection;
  running: boolean;
  /** Another push was requested while one was running; the run goes again. */
  dirty: boolean;
  retryTimer: NodeJS.Timeout | null;
  nextRetryMs: number;
  /** Digest the agent confirmed through `firewall.apply` on this connection. */
  confirmedDigest: string | null;
  /** Digest of a document the agent refused (bad_request): not resent until the rules or the connection change. */
  refusedDigest: string | null;
  /** The last attempt failed (lastError says why). */
  failed: boolean;
  lastError: string | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agentError(error: unknown): string {
  if (error instanceof IncusError) {
    const detail = typeof error.details.message === 'string' ? error.details.message : null;
    return (detail ? `${error.code}: ${detail}` : `${error.code}: ${error.message}`).slice(0, 512);
  }
  return message(error).slice(0, 512);
}

/**
 * Keeps every connected agent's firewall document equal to the rules in the
 * database. Pushes happen when rules change (after commit), when an agent
 * connects (always: an agent only enforces a document the Backend confirmed
 * on the current connection), and when an agent reports a digest other than
 * the desired one. One push per server at a time; transport and agent
 * failures retry with backoff, a refused document waits for the next change.
 * Nothing polls: a Backend restart makes every agent reconnect.
 */
@Injectable()
export class FirewallSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FirewallSyncService.name);
  private readonly states = new Map<string, ServerSync>();
  private unsubscribe?: () => void;

  constructor(
    private readonly agents: AgentRegistry,
    private readonly repository: FirewallRepository,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.agents.onPresence({
      connected: (serverId) => this.connected(serverId),
      disconnected: (serverId) => this.forget(serverId),
      status: (serverId) => this.trigger(serverId, 'status'),
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    for (const serverId of [...this.states.keys()]) this.forget(serverId);
  }

  /** The rules of these servers changed (called after commit). */
  rulesChanged(serverIds: Iterable<string>): void {
    for (const serverId of new Set(serverIds)) this.trigger(serverId, 'push');
  }

  /** Sync state of each server, for the firewall status page. */
  async statuses(servers: ReadonlyArray<{ id: string; name: string }>): Promise<FirewallServerStatusDto[]> {
    const documents = await this.desiredDocuments(servers.map((server) => server.id));
    return servers.map((server) => {
      const { document, ruleCount } = documents.get(server.id)!;
      const live = this.liveState(server.id, document.digest);
      return {
        serverId: server.id,
        serverName: server.name,
        desiredDigest: document.digest,
        agentConnected: live !== null,
        appliedDigest: live?.appliedDigest ?? null,
        ruleCount,
        state: live?.state ?? 'offline',
        error: live?.error ?? null,
      };
    });
  }

  /** `ServerDto.agent.firewall` of each server; null while its agent is not connected. */
  async agentStatuses(serverIds: readonly string[]): Promise<Map<string, ServerAgentDto['firewall']>> {
    const connected = serverIds.filter((serverId) => this.agents.isConnected(serverId));
    const documents = await this.desiredDocuments(connected);
    const result = new Map<string, ServerAgentDto['firewall']>();
    for (const serverId of serverIds) {
      const desired = documents.get(serverId);
      const live = desired ? this.liveState(serverId, desired.document.digest) : null;
      result.set(serverId, live ? { state: live.state, error: live.error } : null);
    }
    return result;
  }

  private liveState(serverId: string, desiredDigest: string): {
    state: Exclude<FirewallSyncState, 'offline'>;
    appliedDigest: string | null;
    error: string | null;
  } | null {
    const connection = this.agents.current(serverId);
    if (!connection) return null;
    const reported = connection.status.firewall;
    const sync = this.states.get(serverId);
    const base = { appliedDigest: reported.digest };
    if (reported.present && reported.digest === desiredDigest) return { ...base, state: 'synced', error: null };
    if (sync?.failed || (!reported.present && reported.error !== null)) {
      return { ...base, state: 'failed', error: sync?.lastError ?? reported.error };
    }
    return { ...base, state: 'pending', error: null };
  }

  private connected(serverId: string): void {
    const connection = this.agents.current(serverId);
    if (!connection) return;
    this.forget(serverId);
    this.states.set(serverId, {
      connection,
      running: false,
      dirty: false,
      retryTimer: null,
      nextRetryMs: FIREWALL_RETRY_INITIAL_MS,
      confirmedDigest: null,
      refusedDigest: null,
      failed: false,
      lastError: null,
    });
    this.trigger(serverId, 'push');
  }

  private forget(serverId: string): void {
    const state = this.states.get(serverId);
    if (!state) return;
    this.clearRetry(state);
    this.states.delete(serverId);
  }

  private trigger(serverId: string, reason: SyncReason): void {
    const state = this.states.get(serverId);
    if (!state) return;
    if (state.running) {
      // A status report while a push is in flight is answered by that push.
      if (reason === 'push') state.dirty = true;
      return;
    }
    // A status report does not cut a backoff short.
    if (reason === 'status' && state.retryTimer) return;
    void this.run(serverId, state, reason);
  }

  private async run(serverId: string, state: ServerSync, first: SyncReason): Promise<void> {
    state.running = true;
    try {
      let reason = first;
      for (;;) {
        state.dirty = false;
        await this.attempt(serverId, state, reason);
        if (!this.isCurrent(serverId, state) || !state.dirty) return;
        reason = 'push';
      }
    } catch (error) {
      this.logger.error(`Firewall sync for server ${serverId} failed unexpectedly: ${message(error)}`);
    } finally {
      state.running = false;
    }
  }

  private async attempt(serverId: string, state: ServerSync, reason: SyncReason): Promise<void> {
    this.clearRetry(state);
    let document: FirewallDocument;
    try {
      document = (await this.desiredDocuments([serverId])).get(serverId)!.document;
    } catch (error) {
      if (this.isCurrent(serverId, state)) this.fail(serverId, state, `Reading the firewall rules failed: ${message(error)}`, true);
      return;
    }
    if (!this.isCurrent(serverId, state)) return;
    const reported = state.connection.status.firewall.digest;
    if (reason === 'status') {
      if (reported === document.digest || document.digest === state.refusedDigest) return;
    } else if (state.confirmedDigest === document.digest && reported === document.digest) {
      return;
    }
    try {
      const applied = await state.connection.applyFirewall(document);
      if (!this.isCurrent(serverId, state)) return;
      if (applied !== document.digest) {
        this.fail(serverId, state, `The agent applied ${applied} instead of ${document.digest}`, true);
        return;
      }
      state.confirmedDigest = applied;
      state.refusedDigest = null;
      state.failed = false;
      state.lastError = null;
      state.nextRetryMs = FIREWALL_RETRY_INITIAL_MS;
    } catch (error) {
      if (!this.isCurrent(serverId, state)) return;
      const refused = error instanceof IncusError && error.code === 'INCUS_BAD_REQUEST';
      if (refused) state.refusedDigest = document.digest;
      this.fail(serverId, state, agentError(error), !refused);
    }
  }

  private fail(serverId: string, state: ServerSync, error: string, retry: boolean): void {
    state.failed = true;
    state.lastError = error;
    if (!retry) {
      this.logger.warn(`Server ${serverId} refused its firewall document: ${error}`);
      return;
    }
    const delay = state.nextRetryMs;
    state.nextRetryMs = Math.min(delay * 2, FIREWALL_RETRY_MAX_MS);
    this.logger.warn(`Firewall sync for server ${serverId} failed (retrying in ${delay / 1000}s): ${error}`);
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      this.trigger(serverId, 'push');
    }, delay);
    state.retryTimer.unref?.();
  }

  private clearRetry(state: ServerSync): void {
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }

  private isCurrent(serverId: string, state: ServerSync): boolean {
    return this.states.get(serverId) === state;
  }

  private async desiredDocuments(serverIds: readonly string[]) {
    return firewallDocuments(serverIds, await this.repository.listServerRules(serverIds));
  }
}
