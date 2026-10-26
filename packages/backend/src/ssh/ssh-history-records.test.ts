import { describe, expect, it } from 'vitest';
import { parseHistoryRecords, peerIp } from './ssh-history-records.js';

const userId = '7f0c4c2e-5b1d-4d38-9a51-0d5c6f0b8a11';

function connection(seq: number, overrides: Record<string, unknown> = {}) {
  return {
    type: 'connection',
    seq,
    connectionSeq: 1,
    peer: '192.0.2.1:2200',
    clientVersion: null,
    login: 'alice',
    userId,
    username: 'alice',
    keyFingerprint: 'SHA256:x',
    keyAlgorithm: 'ssh-ed25519',
    pinned: null,
    connectedAt: 1,
    authenticatedAt: 2,
    closedAt: null,
    closeReason: null,
    bytesFromClient: 0,
    bytesToClient: 0,
    channelsOpened: 0,
    channelsRejected: 0,
    rejectedRequests: {},
    ...overrides,
  };
}

describe('parseHistoryRecords', () => {
  it('merges records of one connection so one upsert can store them', () => {
    const batch = parseHistoryRecords([
      connection(4, { clientVersion: 'SSH-2.0-x', bytesFromClient: 5, rejectedRequests: { session: 2 } }),
      connection(5, { closedAt: 9, closeReason: 'client_closed', bytesFromClient: 3, rejectedRequests: { session: 1, remote_forward: 1 } }),
    ]);
    expect(batch.connections).toHaveLength(1);
    expect(batch.connections[0]).toMatchObject({
      clientVersion: 'SSH-2.0-x',
      closedAt: 9,
      closeReason: 'client_closed',
      bytesFromClient: 5,
      rejectedRequests: { session: 2, remote_forward: 1 },
    });
    expect([batch.firstSeq, batch.lastSeq, batch.skipped]).toEqual([4, 5, 0]);
  });

  it('skips invalid records but still acknowledges past them', () => {
    const batch = parseHistoryRecords([
      connection(1, { userId: 'not-a-uuid' }),
      { type: 'unknown', seq: 2 },
      connection(3),
    ]);
    expect(batch.connections).toHaveLength(1);
    expect([batch.firstSeq, batch.lastSeq, batch.skipped]).toEqual([1, 3, 2]);
  });

  it('sums refusals of the same address and reason, keeping the unbounded rest without one', () => {
    const batch = parseHistoryRecords([{
      type: 'refusals',
      seq: 1,
      windowStart: 10,
      windowEnd: 20,
      refusals: [
        { peerIp: '192.0.2.1', reason: 'no_auth', count: 2 },
        { peerIp: null, reason: 'no_auth', count: 3 },
      ],
    }]);
    expect(batch.refusals).toEqual([
      { windowStart: 10, windowEnd: 20, peerIp: '192.0.2.1', reason: 'no_auth', count: 2 },
      { windowStart: 10, windowEnd: 20, peerIp: '', reason: 'no_auth', count: 3 },
    ]);
  });
});

describe('peerIp', () => {
  it('drops the port of IPv4 and bracketed IPv6 peers', () => {
    expect(peerIp('192.0.2.1:2200')).toBe('192.0.2.1');
    expect(peerIp('[2001:db8::1]:2200')).toBe('2001:db8::1');
    expect(peerIp('2001:db8::1')).toBe('2001:db8::1');
  });
});
