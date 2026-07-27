import { HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS } from '@nyabase/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { performance } from 'node:perf_hooks';
import { HttpProxyGateway, MAX_HTTP_PROXY_CLIENTS } from './http-proxy-gateway.js';

const TEST_TOKEN = 'h'.repeat(64);
const testConfig = () => ({
  get: vi.fn((key: string) => key === 'http.proxyToken' ? TEST_TOKEN : undefined),
});

describe('HttpProxyGateway status projection defenses', () => {
  it('never throws when an internally corrupted status timestamp reaches projection', () => {
    const gateway = makeGateway({ buildSnapshot: vi.fn() });
    const internals = gateway as unknown as {
      latestStatus: Map<object, object>;
    };
    internals.latestStatus.set({}, {
      proxyId: 'proxy-corrupt',
      hostname: null,
      httpListen: '0.0.0.0:8080',
      httpsListen: null,
      uptimeMs: 1,
      connectedAt: 1e300,
      lastSnapshotGeneration: null,
      lastSnapshotAt: null,
      activeConnections: 0,
      totalRequests: Number.POSITIVE_INFINITY,
      totalRejectedRequests: 0,
    });

    expect(() => gateway.getStatus()).not.toThrow();
    expect(gateway.getStatus()).toMatchObject({
      updatedAt: null,
      totalRequests: 0,
    });
    gateway.onModuleDestroy();
  });
});

describe('HttpProxyGateway snapshot broadcast coalescing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the initial-build deadline invariant across wall-clock jumps', async () => {
    let release!: (value: object) => void;
    const service = {
      buildSnapshot: vi.fn()
        .mockImplementationOnce(() => new Promise<object>((resolve) => { release = resolve; }))
        .mockResolvedValueOnce({ generation: 2 }),
    };
    const gateway = makeGateway(service);
    const client = { readyState: WebSocket.OPEN as number, terminate: vi.fn() };
    const build = (gateway as unknown as {
      buildInitialSnapshotBefore(deadline: number, ws: typeof client): Promise<object>;
    }).buildInitialSnapshotBefore(performance.now() + 100, client);
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    vi.advanceTimersByTime(101);
    expect(client.terminate).toHaveBeenCalledOnce();
    release({ generation: 1 });
    await expect(build).rejects.toThrow('deadline exceeded');

    vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));
    await expect((gateway as unknown as {
      buildInitialSnapshotBefore(deadline: number, ws: typeof client): Promise<object>;
    }).buildInitialSnapshotBefore(performance.now() + 100, client))
      .resolves.toEqual({ generation: 2 });
    gateway.onModuleDestroy();
  });

  it('reserves only the bounded number of active or initializing proxy slots', async () => {
    const service = { buildSnapshot: vi.fn() };
    const gateway = makeGateway(service);
    const occupied = Array.from({ length: MAX_HTTP_PROXY_CLIENTS }, () => ({ terminate: vi.fn() }));
    const internals = gateway as unknown as {
      clients: Set<(typeof occupied)[number]>;
      handleConnection: (ws: { terminate: ReturnType<typeof vi.fn> }, req: unknown) => Promise<void>;
    };
    occupied.forEach((client) => internals.clients.add(client));
    const rejected = { terminate: vi.fn() };

    await internals.handleConnection(rejected, {});

    expect(rejected.terminate).toHaveBeenCalledOnce();
    expect(service.buildSnapshot).not.toHaveBeenCalled();
    gateway.onModuleDestroy();
  });

  it('retains an initializing slot after close until the snapshot build settles', async () => {
    let release!: (value: object) => void;
    const service = {
      buildSnapshot: vi.fn(() => new Promise<object>((resolve) => { release = resolve; })),
    };
    const gateway = makeGateway(service);
    const client = {
      readyState: WebSocket.OPEN as number,
      bufferedAmount: 0,
      send: vi.fn(),
      terminate: vi.fn(),
      on: vi.fn(),
    };
    const internals = gateway as unknown as {
      initializingClients: Set<typeof client>;
      removeAdmittedClient(ws: typeof client): void;
      handleConnection(ws: typeof client, req: { headers: Record<string, string> }): Promise<void>;
    };
    const connection = internals.handleConnection(client, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    await vi.waitFor(() => expect(service.buildSnapshot).toHaveBeenCalledOnce());

    client.readyState = WebSocket.CLOSED;
    internals.removeAdmittedClient(client);
    expect(internals.initializingClients.has(client)).toBe(true);

    release({
      generation: 1,
      createdAt: '',
      staleAfterMs: HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
      validUntil: Date.now() + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
      routes: [],
      domainPools: [],
    });
    await connection;
    expect(internals.initializingClients.has(client)).toBe(false);
    expect(client.send).not.toHaveBeenCalled();
    gateway.onModuleDestroy();
  });

  it('runs one build at a time and preserves the newest dirty notification', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = {
      buildSnapshot: vi.fn()
        .mockImplementationOnce(async () => {
          await gate;
          return {
            generation: 1,
            createdAt: '',
            staleAfterMs: HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
            validUntil: Date.now() + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
            routes: [],
            domainPools: [],
          };
        })
        .mockResolvedValueOnce({
          generation: 2,
          createdAt: '',
          staleAfterMs: HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
          validUntil: Date.now() + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
          routes: [],
          domainPools: [],
        }),
    };
    const gateway = makeGateway(service);
    const client = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: vi.fn(), terminate: vi.fn() };
    (gateway as unknown as { clients: Set<typeof client> }).clients.add(client);

    const first = gateway.broadcastSnapshot();
    const second = gateway.broadcastSnapshot();
    const third = gateway.broadcastSnapshot();
    expect(service.buildSnapshot).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second, third]);

    expect(service.buildSnapshot).toHaveBeenCalledTimes(2);
    expect(client.send.mock.calls.map(([encoded]) => JSON.parse(encoded).payload.generation))
      .toEqual([2]);
    gateway.onModuleDestroy();
  });

  it('terminates a backpressured client instead of leaving stale routes active', async () => {
    const service = {
      buildSnapshot: vi.fn().mockResolvedValue({
        generation: 1,
        createdAt: '',
        staleAfterMs: HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
        validUntil: Date.now() + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
        routes: [],
        domainPools: [],
      }),
    };
    const gateway = makeGateway(service);
    const client = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 9 * 1024 * 1024,
      send: vi.fn(),
      terminate: vi.fn(),
    };
    const clients = (gateway as unknown as { clients: Set<typeof client> }).clients;
    clients.add(client);

    await gateway.broadcastSnapshot();

    expect(client.send).not.toHaveBeenCalled();
    expect(client.terminate).toHaveBeenCalledOnce();
    expect(clients.has(client)).toBe(false);
    gateway.onModuleDestroy();
  });

  it('terminates when the next snapshot itself crosses the outbound buffer limit', async () => {
    const service = {
      buildSnapshot: vi.fn().mockResolvedValue({
        generation: 1,
        createdAt: '',
        staleAfterMs: HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
        validUntil: Date.now() + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
        routes: [],
        domainPools: [],
      }),
    };
    const gateway = makeGateway(service);
    const client = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 8 * 1024 * 1024 - 1,
      send: vi.fn(),
      terminate: vi.fn(),
    };
    (gateway as unknown as { clients: Set<typeof client> }).clients.add(client);

    await gateway.broadcastSnapshot();

    expect(client.send).not.toHaveBeenCalled();
    expect(client.terminate).toHaveBeenCalledOnce();
    gateway.onModuleDestroy();
  });

  it('applies the same outbound byte limit to the initial snapshot', () => {
    const gateway = makeGateway({ buildSnapshot: vi.fn() });
    const client = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(),
      terminate: vi.fn(),
    };
    const clients = (gateway as unknown as { clients: Set<typeof client> }).clients;
    clients.add(client);
    const sendSnapshot = (gateway as unknown as {
      sendSnapshot: (ws: typeof client, message: unknown, encoded: string) => boolean;
    }).sendSnapshot.bind(gateway);

    expect(sendSnapshot(
      client,
      { kind: 'snapshot', payload: { generation: 1 } },
      'x'.repeat(8 * 1024 * 1024 + 1),
    )).toBe(false);
    expect(client.send).not.toHaveBeenCalled();
    expect(client.terminate).toHaveBeenCalledOnce();
    expect(clients.has(client)).toBe(false);
    gateway.onModuleDestroy();
  });

  it('renews snapshots before half of the lease elapses and stops on destroy', async () => {
    let generation = 0;
    const service = {
      buildSnapshot: vi.fn(async () => ({
        generation: ++generation,
        createdAt: '',
        staleAfterMs: HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
        validUntil: Date.now() + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
        routes: [],
        domainPools: [],
      })),
    };
    const gateway = makeGateway(service);
    const client = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: vi.fn(), terminate: vi.fn() };
    (gateway as unknown as { clients: Set<typeof client> }).clients.add(client);

    await vi.advanceTimersByTimeAsync(Math.floor(HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS / 3));
    expect(service.buildSnapshot).toHaveBeenCalledOnce();
    expect(client.send).toHaveBeenCalledOnce();

    gateway.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS);
    expect(service.buildSnapshot).toHaveBeenCalledOnce();
  });

  it('reports availability only while a proxy has acknowledged a fresh lease', async () => {
    let generation = 0;
    const service = {
      buildSnapshot: vi.fn(async () => ({
        generation: ++generation,
        createdAt: '',
        staleAfterMs: HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
        validUntil: Date.now() + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
        routes: [],
        domainPools: [],
      })),
    };
    const gateway = makeGateway(service);
    const client = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: vi.fn(), terminate: vi.fn() };
    (gateway as unknown as { clients: Set<typeof client> }).clients.add(client);
    const handleMessage = (gateway as unknown as {
      handleMessage: (ws: typeof client, raw: string) => void;
    }).handleMessage.bind(gateway);

    expect(gateway.isOnline()).toBe(false);
    await gateway.broadcastSnapshot();
    handleMessage(client, JSON.stringify({ ts: Date.now(), kind: 'ack', payload: { generation: 1 } }));
    expect(gateway.isOnline()).toBe(true);

    await vi.advanceTimersByTimeAsync(HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS);
    expect(gateway.isOnline()).toBe(false);
    gateway.onModuleDestroy();
  });

  it('registers immediate post-commit notifications and unregisters on destroy', async () => {
    const service = {
      buildSnapshot: vi.fn().mockResolvedValue({
        generation: 1,
        createdAt: '',
        staleAfterMs: HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
        validUntil: Date.now() + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
        routes: [],
        domainPools: [],
      }),
    };
    let listener!: (reason: string) => Promise<void>;
    const unregister = vi.fn();
    const notifier = {
      register: vi.fn((_channel: string, registered: typeof listener) => {
        listener = registered;
        return unregister;
      }),
    };
    const gateway = new HttpProxyGateway(
      service as never,
      testConfig() as never,
      notifier as never,
    );
    const client = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: vi.fn(), terminate: vi.fn() };
    (gateway as unknown as { clients: Set<typeof client> }).clients.add(client);

    gateway.onModuleInit();
    await listener('container_delete_committed');

    expect(notifier.register).toHaveBeenCalledWith('http', expect.any(Function));
    expect(client.send).toHaveBeenCalledOnce();
    gateway.onModuleDestroy();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it('discards an initial snapshot built across a committed revocation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = {
      buildSnapshot: vi.fn()
        .mockImplementationOnce(async () => {
          await gate;
          return {
            generation: 1,
            createdAt: '',
            staleAfterMs: HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
            validUntil: Date.now() + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
            routes: [{ bindingId: 'revoked' }],
            domainPools: [],
          };
        })
        .mockResolvedValueOnce({
          generation: 2,
          createdAt: '',
          staleAfterMs: HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
          validUntil: Date.now() + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
          routes: [],
          domainPools: [],
        }),
    };
    const gateway = makeGateway(service);
    const client = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(),
      terminate: vi.fn(),
      on: vi.fn(),
    };
    const connection = (gateway as unknown as {
      handleConnection: (ws: typeof client, req: { headers: Record<string, string> }) => Promise<void>;
    }).handleConnection(client, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    await vi.waitFor(() => expect(service.buildSnapshot).toHaveBeenCalledTimes(1));
    gateway.scheduleBroadcast('container_delete_committed');
    release();
    await connection;

    const sentGenerations = client.send.mock.calls.map(([encoded]) => JSON.parse(encoded).payload.generation);
    expect(sentGenerations).not.toContain(1);
    expect(sentGenerations).toContain(2);
    expect(service.buildSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
    gateway.onModuleDestroy();
  });

  it('destroys the upgrade socket when ws.handleUpgrade throws synchronously', () => {
    const gateway = makeGateway({ buildSnapshot: vi.fn() });
    const server = new EventEmitter();
    gateway.attachToHttpServer(server as never);
    const wss = (gateway as unknown as { wss: { handleUpgrade: (...args: unknown[]) => void } }).wss;
    vi.spyOn(wss, 'handleUpgrade').mockImplementation(() => {
      throw new Error('bad upgrade');
    });
    const socket = { destroy: vi.fn() };

    expect(() => server.emit(
      'upgrade',
      { url: '/ws/http-proxy' },
      socket,
      Buffer.alloc(0),
    )).not.toThrow();
    expect(socket.destroy).toHaveBeenCalledOnce();
    gateway.onModuleDestroy();
  });

  it('installs an error listener before initial snapshot I/O yields', async () => {
    let release!: (value: object) => void;
    const initial = new Promise<object>((resolve) => { release = resolve; });
    const snapshot = {
      generation: 1,
      createdAt: '',
      staleAfterMs: HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
      validUntil: Date.now() + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
      routes: [],
      domainPools: [],
    };
    const service = {
      buildSnapshot: vi.fn()
        .mockImplementationOnce(() => initial)
        .mockResolvedValue({ ...snapshot, generation: 2 }),
    };
    const gateway = makeGateway(service);
    const server = new EventEmitter();
    gateway.attachToHttpServer(server as never);
    const wss = (gateway as unknown as { wss: EventEmitter }).wss;
    const client = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(),
      terminate: vi.fn(),
    });

    wss.emit('connection', client, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(service.buildSnapshot).toHaveBeenCalledOnce();
    expect(() => client.emit('error', new Error('early failure'))).not.toThrow();

    release(snapshot);
    await Promise.resolve();
    await Promise.resolve();
    gateway.onModuleDestroy();
  });
});

function makeGateway(service: object): HttpProxyGateway {
  return new HttpProxyGateway(
    service as never,
    testConfig() as never,
    { register: vi.fn(() => vi.fn()) } as never,
  );
}
