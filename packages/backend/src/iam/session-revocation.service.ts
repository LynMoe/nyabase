import { Injectable, Logger } from '@nestjs/common';

export type SessionRevocationListener = (userId: string) => void;

/**
 * In-process signal that a user's live sessions must end now: disable,
 * delete, role change, password change/reset or any other `auth_version`
 * bump. HTTP requests re-read the user row anyway; this is for long-lived
 * connections (the container console) that authenticated once.
 *
 * Writers call `revoke` from `afterCommit`. A per-user generation lets a
 * connection that authenticated concurrently detect a revocation it missed
 * between its credential check and its registration.
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
    for (const listener of this.listeners) {
      try {
        listener(userId);
      } catch (error) {
        this.logger.warn(`Session revocation listener failed: ${
          error instanceof Error ? error.message : String(error)
        }`);
      }
    }
  }
}
