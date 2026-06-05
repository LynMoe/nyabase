import type { PullProgressPayload } from '@nyabase/common';

/** Delay before removing a completed / errored pull entry from in-memory state. */
const DONE_CLEANUP_DELAY_MS = 10_000; // 10 seconds
const ERROR_CLEANUP_DELAY_MS = 30_000; // 30 seconds

/**
 * Tracks in-flight image pull progress for all connected agents.
 *
 * Key format: `${serverId}:${dockerRef}` — matches what the agent sends.
 *
 * Responsibilities:
 * - Store the latest progress snapshot so polling clients get immediate state.
 * - Fan-out live updates to registered SSE/stream listeners.
 * - Auto-expire completed / errored entries after a short grace period.
 * - Clear all entries for a disconnected server.
 */
export class PullProgressTracker {
  /** Latest progress per `serverId:dockerRef` key; read by ImagesService. */
  readonly progress: Map<string, PullProgressPayload> = new Map();

  private listeners: Set<(p: PullProgressPayload) => void> = new Set();

  /**
   * Register a listener for all incoming pull progress events.
   * Returns an unsubscribe function.
   */
  onProgress(cb: (p: PullProgressPayload) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Handle an incoming pull progress payload from the agent.
   * Updates state, fans out to listeners, and schedules cleanup.
   *
   * @param onDone - Called with the serverId when a pull completes successfully,
   *                 so the caller can send a reconcile to the agent.
   */
  handle(pp: PullProgressPayload, onDone: (serverId: string) => void): void {
    const key = `${pp.serverId}:${pp.dockerRef}`;
    this.progress.set(key, pp);
    this.listeners.forEach((cb) => cb(pp));

    if (pp.status === 'done') {
      onDone(pp.serverId);
      const t = setTimeout(() => this.progress.delete(key), DONE_CLEANUP_DELAY_MS);
      if (typeof t === 'object' && 'unref' in t) (t as ReturnType<typeof setTimeout>).unref?.();
    } else if (pp.status === 'error') {
      const t = setTimeout(() => this.progress.delete(key), ERROR_CLEANUP_DELAY_MS);
      if (typeof t === 'object' && 'unref' in t) (t as ReturnType<typeof setTimeout>).unref?.();
    }
  }

  /** Remove all in-flight pull entries for a disconnected server. */
  clearServer(serverId: string): void {
    for (const key of this.progress.keys()) {
      if (key.startsWith(`${serverId}:`)) this.progress.delete(key);
    }
  }
}
