import type { LogChunkPayload } from '@nyabase/common';

export const MAX_PENDING_CONSOLE_CHUNKS_PER_SESSION = 256;
export const MAX_PENDING_CONSOLE_DATA_CHARS_PER_SESSION = 256 * 1024;

interface ConsoleChunkQueue {
  tail: Promise<void>;
  pending: number;
  dataChars: number;
  eofQueued: boolean;
}

/**
 * Keeps the lossy Console stream ordered without placing it on the Agent's
 * authoritative inventory queue. Ordinary data may be dropped under bounded
 * overload, but EOF is admitted exactly once and can never overtake data that
 * was already accepted for the same exec session.
 */
export class ConsoleChunkOrderer {
  private readonly queues = new Map<string, ConsoleChunkQueue>();

  enqueue(
    chunk: LogChunkPayload,
    work: () => Promise<void>,
    onError: (error: unknown) => void,
  ): boolean {
    let queue = this.queues.get(chunk.sessionId);
    if (!queue) {
      queue = {
        tail: Promise.resolve(),
        pending: 0,
        dataChars: 0,
        eofQueued: false,
      };
      this.queues.set(chunk.sessionId, queue);
    }
    if (queue.eofQueued) return false;
    if (
      !chunk.eof
      && (
        queue.pending >= MAX_PENDING_CONSOLE_CHUNKS_PER_SESSION
        || queue.dataChars + chunk.data.length
          > MAX_PENDING_CONSOLE_DATA_CHARS_PER_SESSION
      )
    ) return false;
    if (chunk.eof) queue.eofQueued = true;
    queue.pending += 1;
    queue.dataChars += chunk.data.length;

    const current = queue;
    const execution = current.tail.then(work, work);
    current.tail = execution
      .catch((error) => {
        try {
          onError(error);
        } catch {
          // Error reporting cannot break ordering or create an unhandled tail.
        }
      })
      .finally(() => {
        current.pending -= 1;
        current.dataChars -= chunk.data.length;
        if (
          current.pending === 0
          && this.queues.get(chunk.sessionId) === current
        ) {
          this.queues.delete(chunk.sessionId);
        }
      });
    return true;
  }

  clear(): void {
    this.queues.clear();
  }
}
