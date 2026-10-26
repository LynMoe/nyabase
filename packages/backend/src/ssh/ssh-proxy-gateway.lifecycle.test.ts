import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  SshProxyGateway,
  SSH_PROXY_PAUSE_ADMIT_FLUSH_MS,
  SSH_PROXY_REFUSED_LOGIN_SUMMARY_MS,
} from './ssh-proxy-gateway.js';

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  closed = false;
  terminated = false;
  private sendImpl: (data: string, cb?: (error?: Error) => void) => void;

  constructor(
    sendImpl?: (data: string, cb?: (error?: Error) => void) => void,
  ) {
    this.sendImpl = sendImpl ?? ((data, cb) => {
      this.sent.push(data);
      cb?.();
    });
  }

  send(data: string, cb?: (error?: Error) => void): void {
    this.sendImpl.call(this, data, cb);
  }

  close(): void {
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }
}

const noHistory = {
  ingest: async () => null,
  checkpoint: () => undefined,
  forget: () => undefined,
};

function makeGateway(history: object = noHistory): SshProxyGateway {
  return new SshProxyGateway(
    {} as never,
    { get: () => 'a'.repeat(32) } as never,
    { register: () => () => undefined } as never,
    history as never,
  );
}

function clientsOf(gateway: SshProxyGateway): Set<FakeSocket> {
  return (gateway as unknown as { clients: Set<FakeSocket> }).clients;
}

function initializingOf(gateway: SshProxyGateway): Set<FakeSocket> {
  return (gateway as unknown as { initializingClients: Set<FakeSocket> }).initializingClients;
}

describe('SshProxyGateway shutdown', () => {
  it('sends pauseAdmit before closing admitted clients', async () => {
    const gateway = makeGateway();
    const client = new FakeSocket();
    clientsOf(gateway).add(client);
    await gateway.onModuleDestroy();
    expect(client.sent).toHaveLength(1);
    expect(JSON.parse(client.sent[0]!).kind).toBe('pauseAdmit');
    expect(JSON.parse(client.sent[0]!).payload).toEqual({ reason: 'backend shutting down' });
    expect(client.closed).toBe(true);
  });

  it('still closes admitted clients when send throws', async () => {
    const gateway = makeGateway();
    const client = new FakeSocket(() => {
      throw new Error('send failed');
    });
    const initializing = new FakeSocket();
    clientsOf(gateway).add(client);
    initializingOf(gateway).add(initializing);
    await gateway.onModuleDestroy();
    expect(client.closed || client.terminated).toBe(true);
    expect(initializing.terminated).toBe(true);
  });

  it('terminates a hung pauseAdmit send at the flush deadline', async () => {
    vi.useFakeTimers();
    const gateway = makeGateway();
    const client = new FakeSocket(() => undefined);
    clientsOf(gateway).add(client);
    const done = gateway.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(SSH_PROXY_PAUSE_ADMIT_FLUSH_MS);
    await done;
    expect(client.terminated).toBe(true);
    vi.useRealTimers();
  });

  it('does not broadcast snapshots after destroy', async () => {
    const gateway = makeGateway();
    const client = new FakeSocket();
    clientsOf(gateway).add(client);
    await gateway.onModuleDestroy();
    client.sent.length = 0;
    await gateway.broadcastSnapshot();
    expect(client.sent).toHaveLength(0);
  });
});

describe('SshProxyGateway snapshot build failure', () => {
  it('sends nothing and logs at error level when the proxies will fail closed', async () => {
    const gateway = new SshProxyGateway(
      { buildSnapshot: () => Promise.reject(new Error('over the cap')) } as never,
      {
        get: (key: string) => (key === 'ssh.proxySnapshotStaleMs' ? 120_000 : 'a'.repeat(32)),
      } as never,
      { register: () => () => undefined } as never,
      noHistory as never,
    );
    const internals = gateway as unknown as {
      sentLeaseEnds: Map<FakeSocket, number>;
      logger: { error: (message: string) => void };
    };
    const client = new FakeSocket();
    clientsOf(gateway).add(client);
    internals.sentLeaseEnds.set(client, Date.now() + 60_000);
    const logged = vi.spyOn(internals.logger, 'error').mockImplementation(() => undefined);

    await expect(gateway.broadcastSnapshot()).rejects.toThrow('over the cap');

    expect(client.sent).toHaveLength(0);
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(
      /^SSH proxy snapshot build failed: over the cap; proxies keep their last snapshot until .* and then fail closed/,
    ));
    await gateway.onModuleDestroy();
  });
});

describe('SshProxyGateway login audit logging', () => {
  function audit(gateway: SshProxyGateway, payload: Record<string, unknown>): void {
    (gateway as unknown as { handleMessage: (ws: unknown, raw: string) => void }).handleMessage(
      new FakeSocket(),
      JSON.stringify({ kind: 'audit', payload: { action: 'login', ts: 1, ...payload } }),
    );
  }

  it('logs successes per login but only a periodic sum of refusals', async () => {
    vi.useFakeTimers();
    const gateway = makeGateway();
    const logger = (gateway as unknown as { logger: { log: (message: string) => void } }).logger;
    const logged = vi.spyOn(logger, 'log').mockImplementation(() => undefined);

    audit(gateway, { ok: true, username: 'alice' });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]![0]).toContain('user=alice');

    for (let attempt = 0; attempt < 50; attempt += 1) {
      audit(gateway, { ok: false, username: `scanner${attempt}`, reason: 'public_key_rejected' });
    }
    audit(gateway, { ok: false, reason: 'invalid_login' });
    expect(logged).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SSH_PROXY_REFUSED_LOGIN_SUMMARY_MS);
    expect(logged).toHaveBeenCalledTimes(2);
    const summary = logged.mock.calls[1]![0];
    expect(summary).toBe(
      'SSH proxy refused 51 login attempt(s) since the last summary: '
      + 'login:invalid_login=1 login:public_key_rejected=50',
    );
    expect(summary).not.toContain('scanner');

    await vi.advanceTimersByTimeAsync(SSH_PROXY_REFUSED_LOGIN_SUMMARY_MS);
    expect(logged).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('SshProxyGateway history', () => {
  function handle(gateway: SshProxyGateway, client: FakeSocket, message: unknown): void {
    (gateway as unknown as { handleMessage: (ws: FakeSocket, raw: string) => void })
      .handleMessage(client, JSON.stringify(message));
  }

  it('acknowledges a history frame only once it was stored', async () => {
    let store: (seq: number | null) => void = () => undefined;
    const payloads: unknown[] = [];
    const gateway = makeGateway({
      ...noHistory,
      ingest: (_ws: unknown, payload: unknown) => {
        payloads.push(payload);
        return new Promise<number | null>((resolve) => { store = resolve; });
      },
    });
    const client = new FakeSocket();
    const payload = { proxyId: 'p', instanceId: 'i', records: [{ seq: 7 }] };
    handle(gateway, client, { kind: 'history', payload });
    expect(payloads).toEqual([payload]);
    await Promise.resolve();
    expect(client.sent).toHaveLength(0);

    store(7);
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    expect(JSON.parse(client.sent[0]!)).toMatchObject({ kind: 'historyAck', payload: { seq: 7 } });
  });

  it('sends no acknowledgement when nothing was stored', async () => {
    const gateway = makeGateway();
    const client = new FakeSocket();
    handle(gateway, client, { kind: 'history', payload: {} });
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.sent).toHaveLength(0);
  });
});
