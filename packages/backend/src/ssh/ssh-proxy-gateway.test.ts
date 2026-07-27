import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { performance } from 'node:perf_hooks';
import {
  MAX_SSH_PROXY_CLIENTS,
  MAX_SSH_PROXY_BUFFERED_BYTES,
  SshProxyGateway,
  sshProxySnapshotRenewalMs,
} from './ssh-proxy-gateway.js';
import {
  SSH_PROXY_SNAPSHOT_STALE_MAX_MS,
  SSH_PROXY_SNAPSHOT_STALE_MIN_MS,
} from '@nyabase/common';

const TEST_TOKEN = 's'.repeat(64);
const defaultConfig = (staleAfter: number | (() => number) = 300_000) => ({
  get: vi.fn((key: string) => {
    if (key === 'ssh.proxyToken') return TEST_TOKEN;
    return typeof staleAfter === 'function' ? staleAfter() : staleAfter;
  }),
});

describe('SshProxyGateway status projection defenses', () => {
  it('never throws when an internally corrupted status timestamp reaches projection', () => {
    const gateway = new SshProxyGateway(
      { buildSnapshot: vi.fn() } as never,
      defaultConfig() as never,
      { register: vi.fn() } as never,
    );
    const internals = gateway as unknown as {
      latestStatus: Map<object, object>;
    };
    internals.latestStatus.set({}, {
      proxyId: 'proxy-corrupt',
      hostname: null,
      listen: '0.0.0.0:2222',
      uptimeMs: 1,
      connectedAt: 1e300,
      lastSnapshotGeneration: null,
      lastSnapshotAt: null,
      activeConnections: 0,
      totalConnections: Number.POSITIVE_INFINITY,
      totalRejectedConnections: 0,
      totalClosedConnections: 0,
      totalBytesFromClient: 0,
      totalBytesToClient: 0,
      bandwidthInBps: 0,
      bandwidthOutBps: 0,
      connections: [],
    });

    expect(() => gateway.getStatus()).not.toThrow();
    expect(gateway.getStatus()).toMatchObject({
      updatedAt: null,
      totalConnections: 0,
    });
    gateway.onModuleDestroy();
  });
});

describe('SshProxyGateway snapshot broadcast coalescing', () => {
  it('keeps the initial-build deadline invariant across wall-clock jumps', async () => {
    vi.useFakeTimers();
    try {
      let release!: (value: object) => void;
      const snapshots = {
        buildSnapshot: vi.fn()
          .mockImplementationOnce(() => new Promise<object>((resolve) => { release = resolve; }))
          .mockResolvedValueOnce({ generation: 2 }),
      };
      const gateway = new SshProxyGateway(
        snapshots as never,
        defaultConfig() as never,
        { register: vi.fn() } as never,
      );
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
    } finally {
      vi.useRealTimers();
    }
  });

  it('reserves only the bounded number of active or initializing proxy slots', async () => {
    const snapshots = { buildSnapshot: vi.fn() };
    const gateway = new SshProxyGateway(
      snapshots as never,
      defaultConfig() as never,
      { register: vi.fn() } as never,
    );
    const occupied = Array.from({ length: MAX_SSH_PROXY_CLIENTS }, () => ({ terminate: vi.fn() }));
    const internals = gateway as unknown as {
      clients: Set<(typeof occupied)[number]>;
      handleConnection: (ws: { terminate: ReturnType<typeof vi.fn> }, req: unknown) => Promise<void>;
    };
    occupied.forEach((client) => internals.clients.add(client));
    const rejected = { terminate: vi.fn() };

    await internals.handleConnection(rejected, {});

    expect(rejected.terminate).toHaveBeenCalledOnce();
    expect(snapshots.buildSnapshot).not.toHaveBeenCalled();
    gateway.onModuleDestroy();
  });

  it('retains an initializing slot after close until the snapshot build settles', async () => {
    let release!: (value: { generation: number }) => void;
    const snapshots = {
      buildSnapshot: vi.fn(() => new Promise<{ generation: number }>((resolve) => {
        release = resolve;
      })),
    };
    const gateway = new SshProxyGateway(
      snapshots as never,
      defaultConfig() as never,
      { register: vi.fn() } as never,
    );
    const client = {
      readyState: WebSocket.OPEN as number,
      bufferedAmount: 0,
      send: vi.fn(),
      terminate: vi.fn(),
      on: vi.fn(),
    };
    const internals = gateway as unknown as {
      authorize: ReturnType<typeof vi.fn>;
      initializingClients: Set<typeof client>;
      removeAdmittedClient(ws: typeof client): void;
      handleConnection(ws: typeof client, req: unknown): Promise<void>;
    };
    internals.authorize = vi.fn().mockReturnValue(true);
    const connection = internals.handleConnection(client, {});
    await vi.waitFor(() => expect(snapshots.buildSnapshot).toHaveBeenCalledOnce());

    client.readyState = WebSocket.CLOSED;
    internals.removeAdmittedClient(client);
    expect(internals.initializingClients.has(client)).toBe(true);

    release({ generation: 1 });
    await connection;
    expect(internals.initializingClients.has(client)).toBe(false);
    expect(client.send).not.toHaveBeenCalled();
    gateway.onModuleDestroy();
  });

  it('never sends an initial snapshot invalidated while the connection is not yet admitted', async () => {
    let releaseOld!: (snapshot: { generation: number }) => void;
    const snapshots = {
      buildSnapshot: vi.fn()
        .mockImplementationOnce(() => new Promise<{ generation: number }>((resolve) => {
          releaseOld = resolve;
        }))
        .mockResolvedValueOnce({ generation: 2 })
        .mockResolvedValue({ generation: 3 }),
    };
    const gateway = new SshProxyGateway(
      snapshots as never,
      defaultConfig() as never,
      { register: vi.fn() } as never,
    );
    const client = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    };
    const internals = gateway as unknown as {
      authorize: ReturnType<typeof vi.fn>;
      handleConnection: (ws: typeof client, req: unknown) => Promise<void>;
    };
    internals.authorize = vi.fn().mockReturnValue(true);

    const connecting = internals.handleConnection(client, {});
    await vi.waitFor(() => expect(snapshots.buildSnapshot).toHaveBeenCalledOnce());
    // Models the post-commit notifier while this socket is outside `clients`.
    await gateway.broadcastSnapshot();
    releaseOld({ generation: 1 });
    await connecting;
    await vi.waitFor(() => expect(client.send).toHaveBeenCalled());

    const generations = client.send.mock.calls.map(([encoded]) => JSON.parse(encoded).payload.generation);
    expect(generations[0]).toBe(2);
    expect(generations).not.toContain(1);
    gateway.onModuleDestroy();
  });

  it('does not admit or authorize a connection whose initial snapshot finishes after destroy', async () => {
    let release!: (snapshot: { generation: number }) => void;
    const snapshots = {
      buildSnapshot: vi.fn(() => new Promise<{ generation: number }>((resolve) => {
        release = resolve;
      })),
    };
    const gateway = new SshProxyGateway(
      snapshots as never,
      defaultConfig() as never,
      { register: vi.fn() } as never,
    );
    const client = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    };
    const internals = gateway as unknown as {
      authorize: ReturnType<typeof vi.fn>;
      handleConnection: (ws: typeof client, req: unknown) => Promise<void>;
      clients: Set<typeof client>;
    };
    internals.authorize = vi.fn().mockReturnValue(true);

    const connecting = internals.handleConnection(client, {});
    await vi.waitFor(() => expect(snapshots.buildSnapshot).toHaveBeenCalledOnce());
    gateway.onModuleDestroy();
    release({ generation: 1 });
    await connecting;

    expect(client.terminate).toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
    expect(internals.clients.has(client)).toBe(false);
  });

  it('runs one build at a time and coalesces concurrent dirty notifications', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const snapshots = {
      buildSnapshot: vi.fn()
        .mockImplementationOnce(async () => {
          await gate;
          return { generation: 1 };
        })
        .mockResolvedValueOnce({ generation: 2 }),
    };
    const gateway = new SshProxyGateway(
      snapshots as never,
      defaultConfig() as never,
      { register: vi.fn() } as never,
    );
    const client = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(),
      terminate: vi.fn(),
    };
    (gateway as unknown as { clients: Set<typeof client> }).clients.add(client);

    const first = gateway.broadcastSnapshot();
    const second = gateway.broadcastSnapshot();
    const third = gateway.broadcastSnapshot();
    expect(snapshots.buildSnapshot).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second, third]);

    expect(snapshots.buildSnapshot).toHaveBeenCalledTimes(2);
    // The later revision makes generation 1 unpublishable; coalescing sends
    // only the fresh build instead of briefly extending obsolete authority.
    expect(client.send).toHaveBeenCalledOnce();
    expect(client.send.mock.calls.map(([encoded]) => JSON.parse(encoded).payload.generation))
      .toEqual([2]);
  });

  it('terminates a backpressured proxy instead of retaining an obsolete authorization snapshot', async () => {
    const snapshots = { buildSnapshot: vi.fn().mockResolvedValue({ generation: 1 }) };
    const gateway = new SshProxyGateway(
      snapshots as never,
      defaultConfig() as never,
      { register: vi.fn() } as never,
    );
    const client = {
      readyState: WebSocket.OPEN,
      bufferedAmount: MAX_SSH_PROXY_BUFFERED_BYTES,
      send: vi.fn(),
      terminate: vi.fn(),
    };
    (gateway as unknown as { clients: Set<typeof client> }).clients.add(client);

    await gateway.broadcastSnapshot();

    expect(client.send).not.toHaveBeenCalled();
    expect(client.terminate).toHaveBeenCalledOnce();
  });

  it('settles disconnectAll immediately when a proxy send throws and clears pending state', async () => {
    const gateway = new SshProxyGateway(
      { buildSnapshot: vi.fn() } as never,
      defaultConfig() as never,
      { register: vi.fn() } as never,
    );
    const client = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(() => { throw new Error('socket write failed'); }),
      terminate: vi.fn(),
    };
    (gateway as unknown as { clients: Set<typeof client> }).clients.add(client);

    await expect(gateway.disconnectAll()).resolves.toMatchObject({ requested: 1, disconnected: 0 });
    expect(client.terminate).toHaveBeenCalledOnce();
    expect((gateway as unknown as { pendingDisconnectAll: Map<string, unknown> }).pendingDisconnectAll.size).toBe(0);
  });

  it('treats an asynchronous disconnectAll send failure as that proxy reply exactly once', async () => {
    const gateway = new SshProxyGateway(
      { buildSnapshot: vi.fn() } as never,
      defaultConfig() as never,
      { register: vi.fn() } as never,
    );
    const client = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn((_encoded: string, callback: (error?: Error) => void) => callback(new Error('async send failed'))),
      terminate: vi.fn(),
    };
    (gateway as unknown as { clients: Set<typeof client> }).clients.add(client);

    await expect(gateway.disconnectAll()).resolves.toMatchObject({ requested: 1, disconnected: 0 });
    expect(client.terminate).toHaveBeenCalledOnce();
    expect((gateway as unknown as { pendingDisconnectAll: Map<string, unknown> }).pendingDisconnectAll.size).toBe(0);
  });

  it('bounds a corrupt per-proxy disconnect count before aggregation', async () => {
    const gateway = new SshProxyGateway(
      { buildSnapshot: vi.fn() } as never,
      defaultConfig() as never,
      { register: vi.fn() } as never,
    );
    let sent: Record<string, unknown> | undefined;
    const client = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn((encoded: string) => { sent = JSON.parse(encoded); }),
      terminate: vi.fn(),
    };
    (gateway as unknown as { clients: Set<typeof client> }).clients.add(client);

    const completion = gateway.disconnectAll();
    const requestId = (sent?.payload as { requestId: string }).requestId;
    (gateway as unknown as {
      resolveDisconnectAll: (id: string, count: number, socket: typeof client) => void;
    }).resolveDisconnectAll(requestId, Number.POSITIVE_INFINITY, client);

    await expect(completion).resolves.toEqual({ requestId, requested: 1, disconnected: 0 });
  });

  it('destroys the upgrade socket when ws.handleUpgrade throws synchronously', () => {
    const gateway = new SshProxyGateway(
      { buildSnapshot: vi.fn() } as never,
      defaultConfig() as never,
      { register: vi.fn() } as never,
    );
    const server = new EventEmitter();
    gateway.attachToHttpServer(server as never);
    const wss = (gateway as unknown as { wss: { handleUpgrade: (...args: unknown[]) => void } }).wss;
    vi.spyOn(wss, 'handleUpgrade').mockImplementation(() => {
      throw new Error('bad upgrade');
    });
    const socket = { destroy: vi.fn() };

    expect(() => server.emit(
      'upgrade',
      { url: '/ws/ssh-proxy' },
      socket,
      Buffer.alloc(0),
    )).not.toThrow();
    expect(socket.destroy).toHaveBeenCalledOnce();
    gateway.onModuleDestroy();
  });

  it('installs an error listener before initial snapshot I/O yields', async () => {
    let release!: (value: object) => void;
    const initial = new Promise<object>((resolve) => { release = resolve; });
    const snapshots = {
      buildSnapshot: vi.fn()
        .mockImplementationOnce(() => initial)
        .mockResolvedValue({ generation: 2 }),
    };
    const gateway = new SshProxyGateway(
      snapshots as never,
      defaultConfig() as never,
      { register: vi.fn() } as never,
    );
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
    expect(snapshots.buildSnapshot).toHaveBeenCalledOnce();
    expect(() => client.emit('error', new Error('early failure'))).not.toThrow();

    release({ generation: 1 });
    await Promise.resolve();
    await Promise.resolve();
    gateway.onModuleDestroy();
  });
});

describe('SshProxyGateway snapshot lease renewal', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives a bounded renewal interval at or below one third of the lease', () => {
    expect(sshProxySnapshotRenewalMs(SSH_PROXY_SNAPSHOT_STALE_MIN_MS)).toBe(40_000);
    expect(sshProxySnapshotRenewalMs(SSH_PROXY_SNAPSHOT_STALE_MAX_MS)).toBe(60_000);
    expect(() => sshProxySnapshotRenewalMs(SSH_PROXY_SNAPSHOT_STALE_MIN_MS - 1)).toThrow(/between/);
    expect(() => sshProxySnapshotRenewalMs(SSH_PROXY_SNAPSHOT_STALE_MAX_MS + 1)).toThrow(/between/);
  });

  it('renews a healthy idle proxy and stops renewing after module destroy', async () => {
    vi.useFakeTimers();
    const snapshots = { buildSnapshot: vi.fn().mockResolvedValue({ generation: 1 }) };
    const unregister = vi.fn();
    const gateway = new SshProxyGateway(
      snapshots as never,
      defaultConfig() as never,
      { register: vi.fn().mockReturnValue(unregister) } as never,
    );
    const client = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
    };
    (gateway as unknown as { clients: Set<typeof client> }).clients.add(client);

    gateway.onModuleInit();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(snapshots.buildSnapshot).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(snapshots.buildSnapshot).toHaveBeenCalledOnce();
    expect(client.send).toHaveBeenCalledOnce();

    gateway.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(snapshots.buildSnapshot).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it('does not starve a slow healthy build by invalidating it on every renewal tick', async () => {
    vi.useFakeTimers();
    let generation = 0;
    const snapshots = {
      buildSnapshot: vi.fn(() => new Promise<{ generation: number }>((resolve) => {
        setTimeout(() => resolve({ generation: ++generation }), 50_000);
      })),
    };
    const gateway = new SshProxyGateway(
      snapshots as never,
      defaultConfig(SSH_PROXY_SNAPSHOT_STALE_MIN_MS) as never,
      { register: vi.fn().mockReturnValue(vi.fn()) } as never,
    );
    const client = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
    };
    (gateway as unknown as { clients: Set<typeof client> }).clients.add(client);
    gateway.onModuleInit();

    // Renewal starts at t=40000. The t=80000 tick occurs before the 50s build
    // finishes, but must wait for that build instead of invalidating it.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(snapshots.buildSnapshot).toHaveBeenCalledOnce();
    expect(client.send).toHaveBeenCalledOnce();
    expect(JSON.parse(client.send.mock.calls[0]![0]).payload.generation).toBe(1);

    gateway.onModuleDestroy();
  });

  it('recalculates the renewal deadline when the live TTL is shortened', async () => {
    vi.useFakeTimers();
    let staleAfterMs = SSH_PROXY_SNAPSHOT_STALE_MAX_MS;
    const snapshots = { buildSnapshot: vi.fn().mockResolvedValue({ generation: 1 }) };
    const gateway = new SshProxyGateway(
      snapshots as never,
      defaultConfig(() => staleAfterMs) as never,
      { register: vi.fn().mockReturnValue(vi.fn()) } as never,
    );
    const client = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
    };
    (gateway as unknown as { clients: Set<typeof client> }).clients.add(client);
    gateway.onModuleInit();

    staleAfterMs = SSH_PROXY_SNAPSHOT_STALE_MIN_MS;
    await gateway.broadcastSnapshot();
    expect(snapshots.buildSnapshot).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(39_999);
    expect(snapshots.buildSnapshot).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshots.buildSnapshot).toHaveBeenCalledTimes(2);

    gateway.onModuleDestroy();
  });

  it('retries on the next renewal deadline after a snapshot build fails', async () => {
    vi.useFakeTimers();
    const snapshots = {
      buildSnapshot: vi.fn()
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockResolvedValueOnce({ generation: 2 }),
    };
    const gateway = new SshProxyGateway(
      snapshots as never,
      defaultConfig(SSH_PROXY_SNAPSHOT_STALE_MIN_MS) as never,
      { register: vi.fn().mockReturnValue(vi.fn()) } as never,
    );
    const client = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
    };
    (gateway as unknown as { clients: Set<typeof client> }).clients.add(client);
    gateway.onModuleInit();

    await vi.advanceTimersByTimeAsync(40_000);
    expect(snapshots.buildSnapshot).toHaveBeenCalledOnce();
    expect(client.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(40_000);
    expect(snapshots.buildSnapshot).toHaveBeenCalledTimes(2);
    expect(client.send).toHaveBeenCalledOnce();

    gateway.onModuleDestroy();
  });
});
