import type * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  AgentCredentialRejections,
  AgentUpgradeAdmissions,
  clientAddress,
  MAX_AGENT_AUTH_FAILURES_PER_WINDOW,
  REJECTED_AGENT_CREDENTIAL_TTL_MS,
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

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('rejected agent credentials', () => {
  it('counts repeated attempts per server id, most recently seen first', () => {
    let now = 0;
    const rejections = new AgentCredentialRejections(() => now);
    rejections.record(A, 'unknown_server', '192.0.2.1');
    now = 1_000;
    rejections.record(B, 'bad_secret', undefined);
    now = 2_000;
    rejections.record(A, 'unknown_server', '192.0.2.2');
    expect(rejections.list()).toEqual([
      {
        serverId: A,
        reason: 'unknown_server',
        clientAddress: '192.0.2.2',
        firstSeenAt: new Date(0).toISOString(),
        lastSeenAt: new Date(2_000).toISOString(),
        attempts: 2,
      },
      expect.objectContaining({ serverId: B, reason: 'bad_secret', clientAddress: null, attempts: 1 }),
    ]);
  });

  it('evicts the least recently seen entry when full', () => {
    let now = 0;
    const rejections = new AgentCredentialRejections(() => now, 2);
    rejections.record(A, 'unknown_server', undefined);
    now += 1;
    rejections.record(B, 'unknown_server', undefined);
    now += 1;
    rejections.record(A, 'unknown_server', undefined);
    now += 1;
    rejections.record(C, 'unknown_server', undefined);
    expect(rejections.list().map((entry) => entry.serverId)).toEqual([C, A]);
  });

  it('drops an entry once its agent authenticates or stops trying', () => {
    let now = 0;
    const rejections = new AgentCredentialRejections(() => now);
    rejections.record(A, 'bad_secret', undefined);
    rejections.record(B, 'unknown_server', undefined);
    rejections.forget(A);
    expect(rejections.list().map((entry) => entry.serverId)).toEqual([B]);
    now = REJECTED_AGENT_CREDENTIAL_TTL_MS;
    expect(rejections.list()).toEqual([]);
  });
});
