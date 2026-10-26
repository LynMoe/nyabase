import { describe, expect, it } from 'vitest';
import { zAgentBackendFrame, zAgentFrame } from '../index.js';

/** zod 4 rejects a missing z.unknown() key, which zod 3 (and older peers) accepted. */
describe('agent control frames', () => {
  it('accept a successful response without a result', () => {
    expect(zAgentFrame.safeParse({ type: 'response', id: 'a1', ok: true }).success).toBe(true);
    expect(zAgentFrame.safeParse({ type: 'response', id: 'a1', ok: true, result: { x: 1 } }).success).toBe(true);
  });

  it('accept firewall.apply without params, leaving the document to the handler', () => {
    expect(zAgentBackendFrame.safeParse({ type: 'request', id: 'b2', method: 'firewall.apply' }).success).toBe(true);
  });
});
