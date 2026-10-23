/*
 * Incus operations the agent itself started on the Backend's behalf.
 *
 * An operation id is all Incus asks for to read, wait on or attach to an
 * operation, and its metadata carries the exec / console fd secrets. Ids are
 * not secret (`/1.0/events` and `/1.0/operations` announce every one, the
 * host operator's own `incus exec` included), so the policy reaches an
 * operation only if the request that created it went through the policy:
 * its resources were nyabase-managed when it was checked. Anything else is
 * answered as Incus answers an unknown operation.
 */

const OPERATION_PATH_PATTERN = /^\/1\.0\/operations\/([0-9a-f-]{36})$/;
/** An async response is a short envelope; never parse a large body for it. */
const MAX_ENVELOPE_BYTES = 64 * 1024;
export const OPERATION_LEDGER_MAX_ENTRIES = 4_096;
/** Longer than any operation the Backend waits on (image pulls, long exec sessions attach at once). */
export const OPERATION_LEDGER_TTL_MS = 24 * 60 * 60 * 1000;

export interface OperationLookup {
  knows(id: string): boolean;
}

export class OperationLedger implements OperationLookup {
  /** id -> recorded at; insertion order is age order. */
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = OPERATION_LEDGER_MAX_ENTRIES,
    private readonly ttlMs = OPERATION_LEDGER_TTL_MS,
  ) {}

  knows(id: string): boolean {
    this.prune();
    return this.entries.has(id.toLowerCase());
  }

  /** Remember the operation an Incus response says it started (HTTP 202 async envelope). */
  recordResponse(status: number, body: Buffer): void {
    if (status !== 202 || body.byteLength === 0 || body.byteLength > MAX_ENVELOPE_BYTES) return;
    let envelope: unknown;
    try {
      envelope = JSON.parse(body.toString('utf8'));
    } catch {
      return;
    }
    const operation = typeof envelope === 'object' && envelope !== null
      ? (envelope as Record<string, unknown>).operation
      : undefined;
    const match = typeof operation === 'string' ? OPERATION_PATH_PATTERN.exec(operation) : null;
    if (match) this.record(match[1]!);
  }

  record(id: string): void {
    this.prune();
    const key = id.toLowerCase();
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, this.now());
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, recordedAt] of this.entries) {
      if (recordedAt > cutoff) return;
      this.entries.delete(id);
    }
  }
}
