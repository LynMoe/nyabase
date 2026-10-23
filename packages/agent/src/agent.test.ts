import { describe, expect, it, vi } from 'vitest';
import { createAgentHandlers, type AgentDependencies } from './agent.js';
import { AgentRequestError } from './backend-connection.js';
import { LocalIncusError } from './incus-local.js';
import { Ipv6Guard, type NftRunner } from './ipv6-guard.js';
import { OperationLedger } from './operation-ledger.js';

const INSTANCE = 'nyc-0123456789abcdef0123456789abcdef';

const COMPLETE_TABLE = ['forward', 'input', 'output']
  .map((hook) => `hook ${hook}\n iifname "nyh*" ether type { ip6 } drop\n oifname "nyh*" ether type { ip6 } drop`)
  .join('\n');

function harness(guardInPlace: boolean, requestJson = vi.fn(async (): Promise<unknown> => ({}))) {
  const nft: NftRunner = {
    apply: vi.fn(async () => {
      if (!guardInPlace) throw new Error('nft: Operation not permitted');
    }),
    listTable: vi.fn(async () => (guardInPlace ? COMPLETE_TABLE : undefined)),
  };
  const request = vi.fn(async () => ({ status: 202, headers: {}, body: Buffer.from('{}') }));
  const deps = {
    config: {} as AgentDependencies['config'],
    incus: { request, requestJson } as unknown as AgentDependencies['incus'],
    guard: new Ipv6Guard(nft),
    operations: new OperationLedger(),
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

  it('waits only on operations its own requests started', async () => {
    const { handlers, request } = harness(true);
    const id = '0b6b2f5e-2f8f-4b64-8a8e-5f4c4c4c4c4c';
    const wait = { method: 'GET' as const, path: `/1.0/operations/${id}/wait?timeout=30`, timeoutMs: 1_000 };
    const hidden = await handlers.incusHttp(wait, new AbortController().signal);
    expect(hidden.status).toBe(404);
    expect(JSON.parse(Buffer.from(hidden.body, 'base64').toString())).toMatchObject({ error_code: 404 });
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce({
      status: 202,
      headers: {},
      body: Buffer.from(JSON.stringify({ type: 'async', operation: `/1.0/operations/${id}` })),
    });
    await handlers.incusHttp({
      ...start,
      body: Buffer.from(JSON.stringify({ action: 'stop' })).toString('base64'),
    }, new AbortController().signal);
    await handlers.incusHttp(wait, new AbortController().signal);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ path: wait.path }));
  });

  it('refuses an update of a missing instance, but retries when its document cannot be read', async () => {
    const update = {
      method: 'PATCH' as const,
      path: `/1.0/instances/${INSTANCE}`,
      body: Buffer.from(JSON.stringify({ config: { 'limits.memory': '1GiB' } })).toString('base64'),
      timeoutMs: 1_000,
    };
    const missing = harness(true, vi.fn(async () => {
      throw new LocalIncusError('incus_unavailable', 'Instance not found', 404);
    }));
    await expect(missing.handlers.incusHttp(update, new AbortController().signal))
      .rejects.toMatchObject({ code: 'policy_denied' });
    for (const failure of [
      new LocalIncusError('timeout', 'Incus did not answer in time'),
      new LocalIncusError('incus_unavailable', 'Internal error', 500),
    ]) {
      const busy = harness(true, vi.fn(async () => {
        throw failure;
      }));
      await expect(busy.handlers.incusHttp(update, new AbortController().signal))
        .rejects.toMatchObject({ code: failure.code });
      expect(busy.request).not.toHaveBeenCalled();
    }
  });

  it('starts a guest once the guard verifies', async () => {
    const { handlers, request } = harness(true);
    await expect(handlers.incusHttp(start, new AbortController().signal)).resolves.toMatchObject({ status: 202 });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
