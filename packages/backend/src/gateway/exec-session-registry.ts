import { Injectable, Logger } from '@nestjs/common';

export interface ExecSessionInfo {
  serverId: string;
  userId: string;
  dockerId: string;
  /** Unix ms, used for TTL-based cleanup */
  createdAt: number;
  /** True once the browser opened /ws/console and authenticated */
  claimed: boolean;
  /** Cancel the unclaimed-TTL timer */
  expiryTimer?: NodeJS.Timeout;
}

/** Window for the browser to open /ws/console after POST /exec */
const SESSION_TTL_MS = 60_000;

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

  register(sessionId: string, info: Omit<ExecSessionInfo, 'claimed' | 'expiryTimer'>): void {
    const entry: ExecSessionInfo = { ...info, claimed: false };
    entry.expiryTimer = setTimeout(() => {
      const cur = this.sessions.get(sessionId);
      if (!cur || cur.claimed) return;
      this.sessions.delete(sessionId);
      this.logger.warn(`Session ${sessionId} expired unclaimed; sending execClose to agent`);
      this.orphanHandler?.(sessionId, cur);
    }, SESSION_TTL_MS);
    this.sessions.set(sessionId, entry);
  }

  /** Mark session as claimed by the browser WS; cancels TTL expiry */
  claim(sessionId: string): ExecSessionInfo | undefined {
    const info = this.sessions.get(sessionId);
    if (!info) return undefined;
    if (info.expiryTimer) {
      clearTimeout(info.expiryTimer);
      info.expiryTimer = undefined;
    }
    info.claimed = true;
    return info;
  }

  /** Peek without claiming */
  get(sessionId: string): ExecSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  remove(sessionId: string): void {
    const info = this.sessions.get(sessionId);
    if (info?.expiryTimer) clearTimeout(info.expiryTimer);
    this.sessions.delete(sessionId);
  }
}
