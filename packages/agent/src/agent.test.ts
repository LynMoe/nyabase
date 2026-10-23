import { describe, expect, it, vi } from 'vitest';
import { createAgentHandlers, type AgentDependencies } from './agent.js';
import { AgentRequestError } from './backend-connection.js';
import { Ipv6Guard, type NftRunner } from './ipv6-guard.js';

const INSTANCE = 'nyc-0123456789abcdef0123456789abcdef';

const COMPLETE_TABLE = ['forward', 'input', 'output']
  .map((hook) => `hook ${hook}\n iifname "nyh*" ether type { ip6 } drop\n oifname "nyh*" ether type { ip6 } drop`)
  .join('\n');

function harness(guardInPlace: boolean) {
  const nft: NftRunner = {
    apply: vi.fn(async () => {
      if (!guardInPlace) throw new Error('nft: Operation not permitted');
    }),
    listTable: vi.fn(async () => (guardInPlace ? COMPLETE_TABLE : undefined)),
  };
  const request = vi.fn(async () => ({ status: 202, headers: {}, body: Buffer.from('{}') }));
  const deps = {
    config: {} as AgentDependencies['config'],
    incus: { request, requestJson: vi.fn(async () => ({})) } as unknown as AgentDependencies['incus'],
    guard: new Ipv6Guard(nft),
    metrics: { collect: async () => [] },
    credential: () => 'nyak.x.y',
    version: 'test',
    log: () => undefined,
  } satisfies AgentDependencies;
  return { handlers: createAgentHandlers(deps), request };
}

const start = {
  method: 'PUT' as const,
  path: `/1.0/instances/${INSTANCE}/state`,
  body: Buffer.from(JSON.stringify({ action: 'start' })).toString('base64'),
  timeoutMs: 1_000,
};

describe('agent request handling', () => {
  it('refuses to start a guest while the IPv6 guard cannot be put in place', async () => {
    const { handlers, request } = harness(false);
    const refused = handlers.incusHttp(start, new AbortController().signal);
    await expect(refused).rejects.toBeInstanceOf(AgentRequestError);
    await expect(refused).rejects.toMatchObject({ code: 'ipv6_guard_missing' });
    expect(request).not.toHaveBeenCalled();
    // Stopping needs no guard.
    await handlers.incusHttp({
      ...start,
      body: Buffer.from(JSON.stringify({ action: 'stop' })).toString('base64'),
    }, new AbortController().signal);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('starts a guest once the guard verifies', async () => {
    const { handlers, request } = harness(true);
    await expect(handlers.incusHttp(start, new AbortController().signal)).resolves.toMatchObject({ status: 202 });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
