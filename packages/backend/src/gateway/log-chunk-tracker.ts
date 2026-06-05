import type { LogChunkPayload } from '@nyabase/common';
import type { ExecSessionRegistry } from './exec-session-registry.js';

/** Auto-clean a stale listener if no EOF arrives within this window. */
const LOG_LISTENER_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Buffer chunks that arrive before the browser WS connects, then discard after this TTL. */
const LOG_BUFFER_TTL_MS = 30_000; // 30 seconds

/** How often to evict expired buffer entries (no active listener ever registered). */
const LOG_BUFFER_SWEEP_INTERVAL_MS = 60_000; // 1 minute

interface ListenerEntry {
  cb: (chunk: LogChunkPayload) => void;
  serverId: string;
  expiresAt: number;
}

interface BufferEntry {
  chunks: LogChunkPayload[];
  expiresAt: number;
}

/**
 * Manages log-chunk streaming between agent and browser console sessions.
 *
 * Responsibilities:
 * - Buffer chunks that arrive before the browser WebSocket registers a listener.
 * - Replay buffered chunks when the listener is registered.
 * - Auto-expire stale listeners (TTL-based cleanup).
 * - Notify listeners with EOF on agent disconnect.
 */
export class LogChunkTracker {
  /** Active listeners keyed by exec sessionId. */
  private listeners: Map<string, ListenerEntry> = new Map();

  /** Reverse index: serverId → Set of active sessionIds, for O(1) disconnect cleanup. */
  private listenersByServer: Map<string, Set<string>> = new Map();

  /** Pre-listener buffers: chunks that arrived before a listener was registered. */
  private buffers: Map<string, BufferEntry> = new Map();

  private sweepTimer?: NodeJS.Timeout;

  start(): void {
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, buf] of this.buffers) {
        if (now >= buf.expiresAt) {
          this.buffers.delete(sessionId);
        }
      }
    }, LOG_BUFFER_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /**
   * Dispatch a log chunk to its listener or buffer it for later.
   * Called from `AgentGateway.handleMessage` on the `logChunk` kind.
   */
  dispatch(chunk: LogChunkPayload): void {
    const entry = this.listeners.get(chunk.sessionId);
    if (entry) {
      entry.cb(chunk);
      if (chunk.eof) {
        this.removeListener(chunk.sessionId, entry.serverId);
        this.buffers.delete(chunk.sessionId);
      }
      return;
    }

    // No listener yet — buffer until one registers (or TTL expires)
    if (chunk.eof) return; // nothing to buffer for a terminal chunk
    const buf = this.buffers.get(chunk.sessionId);
    const now = Date.now();
    if (buf && now < buf.expiresAt) {
      buf.chunks.push(chunk);
    } else if (!buf || now >= buf.expiresAt) {
      this.buffers.set(chunk.sessionId, { chunks: [chunk], expiresAt: now + LOG_BUFFER_TTL_MS });
    }
  }

  /**
   * Register a listener for a given exec session.
   * Immediately replays any buffered chunks, then forwards live chunks.
   * Returns an unsubscribe function.
   */
  onLogChunk(
    sessionId: string,
    serverId: string,
    cb: (chunk: LogChunkPayload) => void,
  ): () => void {
    const expiresAt = Date.now() + LOG_LISTENER_TTL_MS;
    this.listeners.set(sessionId, { cb, serverId, expiresAt });

    // Maintain reverse index for O(1) disconnect cleanup
    const byServer = this.listenersByServer.get(serverId) ?? new Set<string>();
    byServer.add(sessionId);
    this.listenersByServer.set(serverId, byServer);

    // Replay any buffered chunks
    const buf = this.buffers.get(sessionId);
    if (buf) {
      this.buffers.delete(sessionId);
      for (const chunk of buf.chunks) {
        cb(chunk);
        if (chunk.eof) {
          this.removeListener(sessionId, serverId);
          return () => {}; // already removed, unsubscribe is a no-op
        }
      }
    }

    // Schedule TTL cleanup for sessions that end without sending EOF
    const timer = setTimeout(() => {
      const current = this.listeners.get(sessionId);
      if (current && Date.now() >= current.expiresAt) {
        this.removeListener(sessionId, serverId);
      }
    }, LOG_LISTENER_TTL_MS);
    if (typeof timer === 'object' && 'unref' in timer) {
      (timer as ReturnType<typeof setTimeout>).unref?.();
    }

    return () => this.removeListener(sessionId, serverId);
  }

  /**
   * On agent disconnect: send a synthetic EOF to all active listeners for the server
   * and clean up any associated exec sessions from the registry.
   */
  clearServer(serverId: string, execRegistry?: ExecSessionRegistry): void {
    const sessionIds = this.listenersByServer.get(serverId) ?? new Set<string>();
    for (const sessionId of sessionIds) {
      const entry = this.listeners.get(sessionId);
      if (!entry) continue;
      try {
        entry.cb({ sessionId, data: '', eof: true, exitCode: -1 });
      } catch { /* ignore listener errors */ }
      this.listeners.delete(sessionId);
      this.buffers.delete(sessionId);
      if (execRegistry) {
        const reg = execRegistry.get(sessionId);
        if (reg && reg.serverId === serverId) execRegistry.remove(sessionId);
      }
    }
    this.listenersByServer.delete(serverId);
  }

  private removeListener(sessionId: string, serverId: string): void {
    this.listeners.delete(sessionId);
    this.listenersByServer.get(serverId)?.delete(sessionId);
  }
}
