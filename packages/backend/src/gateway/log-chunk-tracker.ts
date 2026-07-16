import type { LogChunkPayload } from '@nyabase/common';
import type { ExecSessionRegistry } from './exec-session-registry.js';

/** Auto-clean a stale listener if no EOF arrives within this window. */
const LOG_LISTENER_TTL_MS = 30 * 60 * 1000;

/** Buffer chunks that arrive before the browser WS connects, then discard after this TTL. */
const LOG_BUFFER_TTL_MS = 30_000; // 30 seconds

/** How often to evict expired buffer entries (no active listener ever registered). */
const LOG_BUFFER_SWEEP_INTERVAL_MS = 60_000; // 1 minute
const MAX_BUFFERED_SESSIONS = 256;
const MAX_BUFFERED_CHUNKS_PER_SESSION = 256;
export const MAX_BUFFERED_DATA_CHARS_PER_SESSION = 256 * 1024;
export const MAX_BUFFERED_LOG_DATA_CHARS = 16 * 1024 * 1024;
export const MAX_LOG_LISTENERS = 256;
export const MAX_LOG_LISTENERS_PER_SERVER = 64;

interface ListenerEntry {
  cb: (chunk: LogChunkPayload) => void;
  serverId: string;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface BufferEntry {
  chunks: LogChunkPayload[];
  dataChars: number;
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
  private bufferedDataChars = 0;

  private sweepTimer?: NodeJS.Timeout;

  start(): void {
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, buf] of this.buffers) {
        if (now >= buf.expiresAt) {
          this.deleteBuffer(sessionId);
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
    for (const entry of this.listeners.values()) clearTimeout(entry.timer);
    this.listeners.clear();
    this.listenersByServer.clear();
    this.buffers.clear();
    this.bufferedDataChars = 0;
  }

  /**
   * Dispatch a log chunk to its listener or buffer it for later.
   * Called from `AgentGateway.handleMessage` on the `logChunk` kind.
   */
  dispatch(chunk: LogChunkPayload): void {
    const entry = this.listeners.get(chunk.sessionId);
    if (entry) {
      this.touch(chunk.sessionId);
      entry.cb(chunk);
      if (chunk.eof) {
        this.removeListener(chunk.sessionId, entry.serverId);
        this.deleteBuffer(chunk.sessionId);
      }
      return;
    }

    // No listener yet — buffer until one registers (or TTL expires)
    const buf = this.buffers.get(chunk.sessionId);
    const now = Date.now();
    if (buf && now < buf.expiresAt) {
      if (
        buf.chunks.length >= MAX_BUFFERED_CHUNKS_PER_SESSION
        || buf.dataChars + chunk.data.length > MAX_BUFFERED_DATA_CHARS_PER_SESSION
      ) {
        this.deleteBuffer(chunk.sessionId);
        return;
      }
      if (!this.makeBufferRoom(chunk.data.length, chunk.sessionId)) {
        this.deleteBuffer(chunk.sessionId);
        return;
      }
      buf.chunks.push(chunk);
      buf.dataChars += chunk.data.length;
      this.bufferedDataChars += chunk.data.length;
    } else if (!buf || now >= buf.expiresAt) {
      if (chunk.data.length > MAX_BUFFERED_DATA_CHARS_PER_SESSION) return;
      if (buf) this.deleteBuffer(chunk.sessionId);
      while (this.buffers.size >= MAX_BUFFERED_SESSIONS) {
        const oldest = this.buffers.keys().next().value as string | undefined;
        if (!oldest) break;
        this.deleteBuffer(oldest);
      }
      if (!this.makeBufferRoom(chunk.data.length)) return;
      this.buffers.set(chunk.sessionId, {
        chunks: [chunk],
        dataChars: chunk.data.length,
        expiresAt: now + LOG_BUFFER_TTL_MS,
      });
      this.bufferedDataChars += chunk.data.length;
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
    const existing = this.listeners.get(sessionId);
    if (existing) this.removeListener(sessionId, existing.serverId);
    if (this.listeners.size >= MAX_LOG_LISTENERS) {
      throw new Error(`Log listener limit (${MAX_LOG_LISTENERS}) reached`);
    }
    const existingForServer = this.listenersByServer.get(serverId)?.size ?? 0;
    if (existingForServer >= MAX_LOG_LISTENERS_PER_SERVER) {
      throw new Error(`Server log listener limit (${MAX_LOG_LISTENERS_PER_SERVER}) reached`);
    }
    const expiresAt = Date.now() + LOG_LISTENER_TTL_MS;
    const entry: ListenerEntry = { cb, serverId, expiresAt };
    this.listeners.set(sessionId, entry);
    this.scheduleListenerExpiry(sessionId, entry);

    // Maintain reverse index for O(1) disconnect cleanup
    const byServer = this.listenersByServer.get(serverId) ?? new Set<string>();
    byServer.add(sessionId);
    this.listenersByServer.set(serverId, byServer);

    // Replay any buffered chunks
    const buf = this.buffers.get(sessionId);
    if (buf) {
      this.deleteBuffer(sessionId);
      for (const chunk of buf.chunks) {
        cb(chunk);
        if (chunk.eof) {
          this.removeListener(sessionId, serverId);
          return () => {}; // already removed, unsubscribe is a no-op
        }
      }
    }

    return () => this.removeListener(sessionId, serverId);
  }

  touch(sessionId: string): boolean {
    const entry = this.listeners.get(sessionId);
    if (!entry) return false;
    entry.expiresAt = Date.now() + LOG_LISTENER_TTL_MS;
    this.scheduleListenerExpiry(sessionId, entry);
    return true;
  }

  removeSession(sessionId: string): void {
    const entry = this.listeners.get(sessionId);
    if (entry) this.removeListener(sessionId, entry.serverId);
    this.deleteBuffer(sessionId);
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
      this.removeListener(sessionId, serverId);
      this.deleteBuffer(sessionId);
      if (execRegistry) {
        const reg = execRegistry.get(sessionId);
        if (reg && reg.serverId === serverId) execRegistry.remove(sessionId);
      }
    }
    this.listenersByServer.delete(serverId);
  }

  private removeListener(sessionId: string, serverId: string): void {
    const entry = this.listeners.get(sessionId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.listeners.delete(sessionId);
    const byServer = this.listenersByServer.get(serverId);
    byServer?.delete(sessionId);
    if (byServer?.size === 0) this.listenersByServer.delete(serverId);
  }

  private deleteBuffer(sessionId: string): void {
    const buffer = this.buffers.get(sessionId);
    if (!buffer) return;
    this.buffers.delete(sessionId);
    this.bufferedDataChars = Math.max(0, this.bufferedDataChars - buffer.dataChars);
  }

  private makeBufferRoom(additionalChars: number, preserveSessionId?: string): boolean {
    if (additionalChars > MAX_BUFFERED_LOG_DATA_CHARS) return false;
    while (this.bufferedDataChars > MAX_BUFFERED_LOG_DATA_CHARS - additionalChars) {
      const evict = [...this.buffers.keys()].find((sessionId) => sessionId !== preserveSessionId);
      if (!evict) return false;
      this.deleteBuffer(evict);
    }
    return true;
  }

  private scheduleListenerExpiry(sessionId: string, entry: ListenerEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (this.listeners.get(sessionId) === entry && Date.now() >= entry.expiresAt) {
        this.removeListener(sessionId, entry.serverId);
      }
    }, Math.max(1, entry.expiresAt - Date.now()));
    entry.timer.unref?.();
  }
}
