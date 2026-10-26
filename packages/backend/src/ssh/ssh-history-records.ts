import {
  zSshProxyHistoryRecord,
  type SshProxyChannelRecord,
  type SshProxyConnectionRecord,
  type SshProxyRefusalsRecord,
} from '@nyabase/common';

/**
 * What one `history` frame stores. A frame can hold several records of the
 * same connection or channel (open and close); they are merged first because
 * one upsert statement cannot touch a row twice.
 */
export interface HistoryBatch {
  connections: SshProxyConnectionRecord[];
  channels: SshProxyChannelRecord[];
  refusals: RefusalRow[];
  /** Lowest and highest `seq` in the frame, valid records or not; the Backend acknowledges `lastSeq`. */
  firstSeq: number;
  lastSeq: number;
  skipped: number;
}

export interface RefusalRow {
  windowStart: number;
  windowEnd: number;
  /** '' for the addresses beyond the proxy's per-window bound. */
  peerIp: string;
  reason: string;
  count: number;
}

export function parseHistoryRecords(records: readonly unknown[]): HistoryBatch {
  const connections = new Map<number, SshProxyConnectionRecord>();
  const channels = new Map<string, SshProxyChannelRecord>();
  const refusals: RefusalRow[] = [];
  let firstSeq = Number.MAX_SAFE_INTEGER;
  let lastSeq = 0;
  let skipped = 0;
  for (const raw of records) {
    const seq = (raw as { seq?: unknown } | null)?.seq;
    if (Number.isSafeInteger(seq) && (seq as number) >= 0) {
      lastSeq = Math.max(lastSeq, seq as number);
      firstSeq = Math.min(firstSeq, seq as number);
    }
    const parsed = zSshProxyHistoryRecord.safeParse(raw);
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    const record = parsed.data;
    if (record.type === 'connection') {
      const previous = connections.get(record.connectionSeq);
      connections.set(record.connectionSeq, previous ? mergeConnection(previous, record) : record);
    } else if (record.type === 'channel') {
      const key = `${record.connectionSeq}:${record.channelSeq}`;
      const previous = channels.get(key);
      channels.set(key, previous ? mergeChannel(previous, record) : record);
    } else {
      refusals.push(...refusalRows(record));
    }
  }
  return {
    connections: [...connections.values()],
    channels: [...channels.values()],
    refusals,
    firstSeq: Math.min(firstSeq, lastSeq),
    lastSeq,
    skipped,
  };
}

/** Counters only grow; a closing record carries the close. The SQL upsert applies the same rules. */
export function mergeConnection(
  a: SshProxyConnectionRecord,
  b: SshProxyConnectionRecord,
): SshProxyConnectionRecord {
  const closing = b.closedAt !== null ? b : a.closedAt !== null ? a : b;
  const rejectedRequests = { ...a.rejectedRequests };
  for (const [kind, count] of Object.entries(b.rejectedRequests)) {
    rejectedRequests[kind] = Math.max(rejectedRequests[kind] ?? 0, count);
  }
  return {
    ...b,
    clientVersion: b.clientVersion ?? a.clientVersion,
    pinned: b.pinned ?? a.pinned,
    closedAt: closing.closedAt,
    closeReason: closing.closeReason,
    bytesFromClient: Math.max(a.bytesFromClient, b.bytesFromClient),
    bytesToClient: Math.max(a.bytesToClient, b.bytesToClient),
    channelsOpened: Math.max(a.channelsOpened, b.channelsOpened),
    channelsRejected: Math.max(a.channelsRejected, b.channelsRejected),
    rejectedRequests,
  };
}

export function mergeChannel(a: SshProxyChannelRecord, b: SshProxyChannelRecord): SshProxyChannelRecord {
  const closing = b.closedAt !== null ? b : a.closedAt !== null ? a : b;
  return {
    ...b,
    route: b.route ?? a.route,
    closedAt: closing.closedAt,
    closeReason: closing.closeReason,
    bytesFromClient: Math.max(a.bytesFromClient, b.bytesFromClient),
    bytesToClient: Math.max(a.bytesToClient, b.bytesToClient),
  };
}

function refusalRows(record: SshProxyRefusalsRecord): RefusalRow[] {
  const rows = new Map<string, RefusalRow>();
  for (const refusal of record.refusals) {
    const peerIp = refusal.peerIp ?? '';
    const key = `${peerIp}\n${refusal.reason}`;
    const row = rows.get(key);
    if (row) row.count += refusal.count;
    else {
      rows.set(key, {
        windowStart: record.windowStart,
        windowEnd: record.windowEnd,
        peerIp,
        reason: refusal.reason,
        count: refusal.count,
      });
    }
  }
  return [...rows.values()];
}

/** `192.0.2.1:5000` → `192.0.2.1`, `[2001:db8::1]:5000` → `2001:db8::1`. */
export function peerIp(peer: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(peer);
  if (bracketed) return bracketed[1]!;
  const colon = peer.lastIndexOf(':');
  return colon > 0 && peer.indexOf(':') === colon ? peer.slice(0, colon) : peer;
}

/** The proxy instance a record belongs to: one per proxy process. */
export function historyInstanceKey(proxyId: string, instanceId: string): string {
  return `${proxyId}:${instanceId}`;
}
