import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

export interface ExecSessionInfo {
  serverId: string;
  userId: string;
  containerId: string;
  dockerId: string;
  /** Durable authority which must remain true for the lifetime of the shell. */
  authorizationKind: 'container-owner' | 'manage-containers-any';
  /** Unix ms, used for TTL-based cleanup */
  createdAt: number;
  /** True once the browser opened /ws/console and authenticated */
  claimed: boolean;
  /** Cancel the unclaimed-TTL timer */
  expiryTimer?: NodeJS.Timeout;
  /** Close the authenticated browser transport when the runtime/session is revoked. */
  closeClient?: (reason: string) => void;
}

/** Window for the browser to open /ws/console after POST /exec. */
const UNCLAIMED_SESSION_TTL_MS = 60_000;
/** Claimed sessions are interactive, but must not survive a silent browser forever. */
const CLAIMED_IDLE_TTL_MS = 30 * 60_000;
export const MAX_EXEC_SESSIONS = 64;
export const MAX_EXEC_SESSIONS_PER_USER = 8;
export const MAX_EXEC_SESSIONS_PER_SERVER = 16;

@Injectable()
export class ExecSessionRegistry {
  private readonly logger = new Logger(ExecSessionRegistry.name);
  private sessions = new Map<string, ExecSessionInfo>();
  /** Hook invoked when a session must be torn down on the agent (zombie cleanup) */
  private orphanHandler: ((sessionId: string, info: ExecSessionInfo) => void) | null = null;

  /** Wire orphan-cleanup callback (called by AgentGateway during init) */
  setOrphanHandler(fn: (sessionId: string, info: ExecSessionInfo) => void): void {
    this.orphanHandler = fn;
  }

  register(
    sessionId: string,
    info: Omit<ExecSessionInfo, 'claimed' | 'expiryTimer' | 'closeClient'>,
  ): void {
    if (this.sessions.has(sessionId)) {
      throw new ServiceUnavailableException('Exec session ID already exists');
    }
    const entries = [...this.sessions.values()];
    if (entries.length >= MAX_EXEC_SESSIONS) {
      throw new ServiceUnavailableException('Global exec session limit reached');
    }
    if (entries.filter((entry) => entry.userId === info.userId).length >= MAX_EXEC_SESSIONS_PER_USER) {
      throw new ServiceUnavailableException('User exec session limit reached');
    }
    if (entries.filter((entry) => entry.serverId === info.serverId).length >= MAX_EXEC_SESSIONS_PER_SERVER) {
      throw new ServiceUnavailableException('Server exec session limit reached');
    }
    const entry: ExecSessionInfo = { ...info, claimed: false };
    this.sessions.set(sessionId, entry);
    this.scheduleExpiry(sessionId, entry, UNCLAIMED_SESSION_TTL_MS);
  }

  /** Atomically verify ownership and claim the browser transport exactly once. */
  claimForUser(
    sessionId: string,
    userId: string,
    closeClient: (reason: string) => void,
  ): ExecSessionInfo | undefined {
    const info = this.sessions.get(sessionId);
    if (!info || info.claimed || info.userId !== userId) return undefined;
    info.claimed = true;
    info.closeClient = closeClient;
    this.scheduleExpiry(sessionId, info, CLAIMED_IDLE_TTL_MS);
    return info;
  }

  /** Refresh the claimed-session idle deadline after verified browser or agent activity. */
  touch(sessionId: string): boolean {
    const info = this.sessions.get(sessionId);
    if (!info?.claimed) return false;
    this.scheduleExpiry(sessionId, info, CLAIMED_IDLE_TTL_MS);
    return true;
  }

  /** Peek without claiming */
  get(sessionId: string): ExecSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  remove(sessionId: string, expected?: ExecSessionInfo): boolean {
    const info = this.sessions.get(sessionId);
    if (!info || (expected && info !== expected)) return false;
    if (info?.expiryTimer) clearTimeout(info.expiryTimer);
    this.sessions.delete(sessionId);
    return true;
  }

  closeByRuntime(dockerId: string, notifyAgent = true): void {
    for (const [sessionId, info] of [...this.sessions.entries()]) {
      if (info.dockerId !== dockerId) continue;
      this.dispose(sessionId, info, notifyAgent, 'Container runtime is changing');
    }
  }

  /** Drop every process-local session for a disconnected or quarantined Agent. */
  clearServer(serverId: string, notifyAgent = false): void {
    for (const [sessionId, info] of [...this.sessions.entries()]) {
      if (info.serverId !== serverId) continue;
      this.dispose(sessionId, info, notifyAgent, 'Agent connection ended');
    }
  }

  private scheduleExpiry(sessionId: string, info: ExecSessionInfo, timeoutMs: number): void {
    if (info.expiryTimer) clearTimeout(info.expiryTimer);
    info.expiryTimer = setTimeout(() => {
      const current = this.sessions.get(sessionId);
      if (current !== info) return;
      this.logger.warn(`Exec session ${sessionId} expired; sending execClose to agent`);
      this.dispose(sessionId, current, true, 'Console session expired');
    }, timeoutMs);
    info.expiryTimer.unref?.();
  }

  private dispose(
    sessionId: string,
    info: ExecSessionInfo,
    notifyAgent: boolean,
    reason: string,
  ): void {
    if (this.sessions.get(sessionId) !== info) return;
    if (info.expiryTimer) clearTimeout(info.expiryTimer);
    this.sessions.delete(sessionId);
    try { info.closeClient?.(reason); } catch { /* browser transport is best effort */ }
    if (notifyAgent) this.orphanHandler?.(sessionId, info);
  }
}
