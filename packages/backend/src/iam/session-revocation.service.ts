import { Injectable, Logger } from '@nestjs/common';

/**
 * `sessionId` names the one browser (refresh) session that ended; without it
 * every session of the user ended.
 */
export type SessionRevocationListener = (userId: string, sessionId?: string) => void;

/**
 * In-process signal that live sessions must end now. HTTP requests re-read the
 * user row anyway; this is for long-lived connections (the container console)
 * that authenticated once.
 *
 *  - `revoke(userId)`: every session of the user — disable, delete, role
 *    change, password change/reset or any other `auth_version` bump. Writers
 *    call it from `afterCommit`. A per-user generation lets a connection that
 *    authenticated concurrently detect a revocation it missed between its
 *    credential check and its registration.
 *  - `endSession(userId, sessionId)`: one browser session was deleted (logout,
 *    refresh-token reuse), called after the deleting transaction committed.
 *    There is no generation: a connection registers under its session first
 *    and checks the session row afterwards, so it sees either the deletion or
 *    the signal.
 */
@Injectable()
export class SessionRevocationService {
  private readonly logger = new Logger(SessionRevocationService.name);
  private readonly listeners = new Set<SessionRevocationListener>();
  private readonly generations = new Map<string, number>();

  subscribe(listener: SessionRevocationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  generation(userId: string): number {
    return this.generations.get(userId) ?? 0;
  }

  revoke(userId: string): void {
    this.generations.set(userId, this.generation(userId) + 1);
    this.notify(userId);
  }

  endSession(userId: string, sessionId: string): void {
    this.notify(userId, sessionId);
  }

  private notify(userId: string, sessionId?: string): void {
    for (const listener of this.listeners) {
      try {
        listener(userId, sessionId);
      } catch (error) {
        this.logger.warn(`Session revocation listener failed: ${
          error instanceof Error ? error.message : String(error)
        }`);
      }
    }
  }
}
