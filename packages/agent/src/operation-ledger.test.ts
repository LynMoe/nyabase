import { describe, expect, it } from 'vitest';
import { OperationLedger } from './operation-ledger.js';

const ID = '0b6b2f5e-2f8f-4b64-8a8e-5f4c4c4c4c4c';

function envelope(operation: string): Buffer {
  return Buffer.from(JSON.stringify({ type: 'async', status_code: 100, operation, metadata: { id: ID } }));
}

describe('operation ledger', () => {
  it('learns the operations Incus says it started for the agent', () => {
    const ledger = new OperationLedger();
    ledger.recordResponse(200, envelope(`/1.0/operations/${ID}`));
    expect(ledger.knows(ID)).toBe(false);
    ledger.recordResponse(202, envelope(`/1.0/operations/${ID}/websocket`));
    expect(ledger.knows(ID)).toBe(false);
    ledger.recordResponse(202, Buffer.from('not json'));
    ledger.recordResponse(202, envelope(`/1.0/operations/${ID}`));
    expect(ledger.knows(ID)).toBe(true);
    expect(ledger.knows(ID.toUpperCase())).toBe(true);
  });

  it('forgets operations after their lifetime and the oldest beyond its size', () => {
    let now = 0;
    const ledger = new OperationLedger(() => now, 2, 1_000);
    const ids = ['1', '2', '3'].map((digit) => ID.slice(0, -1) + digit);
    ledger.record(ids[0]!);
    now = 10;
    ledger.record(ids[1]!);
    ledger.record(ids[2]!);
    expect(ids.map((id) => ledger.knows(id))).toEqual([false, true, true]);
    now = 1_005;
    expect(ledger.knows(ids[1]!)).toBe(true);
    now = 1_011;
    expect(ledger.knows(ids[1]!)).toBe(false);
  });
});
