import type * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  AgentUpgradeAdmissions,
  clientAddress,
  MAX_AGENT_AUTH_FAILURES_PER_WINDOW,
  type AgentUpgradeAdmission,
} from './agent-credentials.js';

function request(peer: string, forwardedFor?: string): http.IncomingMessage {
  return {
    socket: { remoteAddress: peer },
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  } as unknown as http.IncomingMessage;
}

function settle(admission: AgentUpgradeAdmission, authenticated: boolean): void {
  if (admission.refused) throw new Error(`refused with ${admission.refused}`);
  admission.settle(authenticated);
}

describe('agent upgrade admission', () => {
  it('names the client as Express would, honouring only trusted proxies', () => {
    const loopback = (address: string) => address === '127.0.0.1';
    expect(clientAddress(request('127.0.0.1', '203.0.113.7'), loopback)).toBe('203.0.113.7');
    expect(clientAddress(request('127.0.0.1', '198.51.100.1, 203.0.113.7'), loopback)).toBe('203.0.113.7');
    expect(clientAddress(request('192.0.2.9', '203.0.113.7'), loopback)).toBe('192.0.2.9');
    expect(clientAddress(request('127.0.0.1', '203.0.113.7'), () => false)).toBe('127.0.0.1');
  });

  it('turns an address away after repeated failures but never counts successes', () => {
    let now = 0;
    const admissions = new AgentUpgradeAdmissions(() => false, () => now);
    for (let attempt = 0; attempt < MAX_AGENT_AUTH_FAILURES_PER_WINDOW * 2; attempt += 1) {
      settle(admissions.admit(request('198.51.100.20')), true);
    }
    for (let attempt = 0; attempt < MAX_AGENT_AUTH_FAILURES_PER_WINDOW; attempt += 1) {
      settle(admissions.admit(request('198.51.100.20')), false);
    }
    expect(admissions.admit(request('198.51.100.20'))).toEqual({ refused: 429 });
    // Another host is not affected, and the window passes.
    settle(admissions.admit(request('198.51.100.21')), true);
    now += 10 * 60_000;
    settle(admissions.admit(request('198.51.100.20')), false);
  });

  it('bounds credential lookups in flight', () => {
    const admissions = new AgentUpgradeAdmissions(() => false, Date.now, 2);
    const first = admissions.admit(request('198.51.100.1'));
    admissions.admit(request('198.51.100.2'));
    expect(admissions.admit(request('198.51.100.3'))).toEqual({ refused: 503 });
    settle(first, true);
    settle(first, true);
    expect(admissions.admit(request('198.51.100.3')).refused).toBeUndefined();
    expect(admissions.admit(request('198.51.100.4'))).toEqual({ refused: 503 });
  });
});
