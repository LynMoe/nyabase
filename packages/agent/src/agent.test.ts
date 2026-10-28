import { describe, expect, it, vi } from 'vitest';
import { createAgentHandlers, type AgentDependencies } from './agent.js';
import { AgentRequestError } from './backend-connection.js';
import { LocalIncusError } from './incus-local.js';
import { GuestFirewall } from './firewall.js';
import { FakeNft, firewallDocument, MemoryFirewallStore, SERVER_ID } from './firewall.test-helper.js';
import { Ipv6Guard } from './ipv6-guard.js';
import { NftRefusedError } from './nft.js';
import { OperationLedger } from './operation-ledger.js';

const INSTANCE = 'nyc-0123456789abcdef0123456789abcdef';

const NO_REQUEST = new AbortController().signal;

/** `guardInPlace: false`: nft refuses everything. Otherwise the firewall has a confirmed empty document. */
async function harness(guardInPlace: boolean, requestJson = vi.fn(async (): Promise<unknown> => ({}))) {
  const nft = new FakeNft();
  if (!guardInPlace) nft.failApply = () => new Error('nft: Operation not permitted');
  const store = new MemoryFirewallStore();
  const firewall = new GuestFirewall({ nft, store, serverId: SERVER_ID });
  await firewall.restore();
  if (guardInPlace) await firewall.apply(firewallDocument('0'));
  const request = vi.fn(async () => ({ status: 202, headers: {}, body: Buffer.from('{}') }));
  const deps = {
    config: {} as AgentDependencies['config'],
    incus: { request, requestJson } as unknown as AgentDependencies['incus'],
    guard: new Ipv6Guard(nft),
    firewall,
    operations: new OperationLedger(),
    metrics: { collect: async () => [] },
    cephfsUsage: { apply: async (_method, _path, response) => response },
    credential: () => 'nyak.x.y',
    version: 'test',
    log: () => undefined,
  } satisfies AgentDependencies;
  return { handlers: createAgentHandlers(deps), request, nft, store, firewall };
}

const start = {
  method: 'PUT' as const,
  path: `/1.0/instances/${INSTANCE}/state`,
  body: Buffer.from(JSON.stringify({ action: 'start' })).toString('base64'),
  timeoutMs: 1_000,
};

describe('agent request handling', () => {
  it('refuses to start a guest while the IPv6 guard cannot be put in place', async () => {
    const { handlers, request } = await harness(false);
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
    const { handlers, request } = await harness(true);
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
    const missing = await harness(true, vi.fn(async () => {
      throw new LocalIncusError('incus_unavailable', 'Instance not found', 404);
    }));
    await expect(missing.handlers.incusHttp(update, new AbortController().signal))
      .rejects.toMatchObject({ code: 'policy_denied' });
    for (const failure of [
      new LocalIncusError('timeout', 'Incus did not answer in time'),
      new LocalIncusError('incus_unavailable', 'Internal error', 500),
    ]) {
      const busy = await harness(true, vi.fn(async () => {
        throw failure;
      }));
      await expect(busy.handlers.incusHttp(update, new AbortController().signal))
        .rejects.toMatchObject({ code: failure.code });
      expect(busy.request).not.toHaveBeenCalled();
    }
  });

  it('starts a guest once the guard verifies', async () => {
    const { handlers, request } = await harness(true);
    await expect(handlers.incusHttp(start, new AbortController().signal)).resolves.toMatchObject({ status: 202 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('refuses to start a guest until the firewall document is confirmed on this connection', async () => {
    const { handlers, request, nft } = await harness(true);
    const hello = await handlers.hello();
    expect(hello.status.firewall).toEqual({ present: false, digest: '0'.repeat(64), error: null });
    const refused = handlers.incusHttp(start, NO_REQUEST);
    await expect(refused).rejects.toMatchObject({ code: 'firewall_missing' });
    await expect(refused).rejects.toThrow('has not sent the firewall document');
    expect(request).not.toHaveBeenCalled();
    const applies = nft.applied.length;
    // Same digest: confirmed without rewriting the table.
    await expect(handlers.applyFirewall(firewallDocument('0'), NO_REQUEST)).resolves.toEqual({ digest: '0'.repeat(64) });
    expect(nft.applied).toHaveLength(applies);
    await expect(handlers.incusHttp(start, NO_REQUEST)).resolves.toMatchObject({ status: 202 });
  });

  it('refuses to start a guest while the agent holds no firewall document', async () => {
    const nft = new FakeNft();
    const firewall = new GuestFirewall({ nft, store: new MemoryFirewallStore(), serverId: SERVER_ID });
    await firewall.restore();
    const handlers = createAgentHandlers({
      config: {} as AgentDependencies['config'],
      incus: { request: vi.fn(), requestJson: vi.fn() } as unknown as AgentDependencies['incus'],
      guard: new Ipv6Guard(nft),
      firewall,
      operations: new OperationLedger(),
      metrics: { collect: async () => [] },
      cephfsUsage: { apply: async (_method, _path, response) => response },
      credential: () => 'nyak.x.y',
      version: 'test',
      log: () => undefined,
    });
    await expect(handlers.incusHttp(start, NO_REQUEST)).rejects.toMatchObject({ code: 'firewall_missing' });
    await expect(handlers.incusHttp(start, NO_REQUEST)).rejects.toThrow('no firewall document');
  });

  it('answers a malformed or unloadable firewall document with bad_request and keeps the old one', async () => {
    const { handlers, nft, store, firewall } = await harness(true);
    for (const params of [
      undefined,
      { digest: 'x', rules: [] },
      { digest: '1'.repeat(64), rules: [{ action: 'drop', protocol: 'all', cidrs: ['10.0.0.1/8'], ports: [] }] },
      { digest: '1'.repeat(64), rules: [{ action: 'drop', protocol: 'all', cidrs: ['10.0.0.0/8'], ports: [{ from: 1, to: 2 }] }] },
      { ...firewallDocument('1'), extra: true },
    ]) {
      await expect(handlers.applyFirewall(params, NO_REQUEST)).rejects.toMatchObject({ code: 'bad_request' });
    }
    nft.failCheck = () => new NftRefusedError('nft exited with 1: Error: Could not process rule');
    await expect(handlers.applyFirewall(firewallDocument('1'), NO_REQUEST)).rejects.toMatchObject({ code: 'bad_request' });
    expect(store.writes.map((write) => write.document.digest)).toEqual(['0'.repeat(64)]);
    expect(firewall.status()).toEqual({ present: true, digest: '0'.repeat(64), error: null });
    // A failure that is not the document's is retryable.
    nft.failCheck = undefined;
    store.failWrite = true;
    await expect(handlers.applyFirewall(firewallDocument('1'), NO_REQUEST)).rejects.toMatchObject({ code: 'internal' });
    store.failWrite = false;
    await expect(handlers.applyFirewall(firewallDocument('1'), NO_REQUEST)).resolves.toEqual({ digest: '1'.repeat(64) });
  });

  it('reports both tables in hello', async () => {
    const { handlers } = await harness(true);
    const hello = await handlers.hello();
    expect(hello.status).toEqual({
      ipv6Guard: { present: false, error: 'not verified yet' },
      firewall: { present: false, digest: '0'.repeat(64), error: null },
    });
  });
});
