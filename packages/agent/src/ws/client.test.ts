import { afterEach, describe, expect, it, vi } from 'vitest';

const fakeWs = vi.hoisted(() => ({
  sockets: [] as Array<{
    readyState: number;
    bufferedAmount: number;
    closeCalls: Array<[number?, string?]>;
    terminateCalls: number;
    pingCalls: number;
    sendCalls: string[];
    emitOpen(): void;
    emitMessage(value: unknown): Promise<void>;
    emitPong(): void;
    emitClose(code?: number, reason?: string): Promise<void>;
  }>,
}));

vi.mock('ws', () => {
  class FakeWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    readyState = FakeWebSocket.OPEN;
    bufferedAmount = 0;
    readonly closeCalls: Array<[number?, string?]> = [];
    terminateCalls = 0;
    pingCalls = 0;
    readonly sendCalls: string[] = [];
    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(_url: string, _options: unknown) {
      fakeWs.sockets.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void): void {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    }

    emitOpen(): void {
      for (const handler of this.handlers.get('open') ?? []) handler();
    }

    async emitMessage(value: unknown): Promise<void> {
      await Promise.all(
        (this.handlers.get('message') ?? []).map((handler) => handler(Buffer.from(JSON.stringify(value)))),
      );
    }

    emitPong(): void {
      for (const handler of this.handlers.get('pong') ?? []) handler();
    }

    async emitClose(code = 1006, reason = ''): Promise<void> {
      this.readyState = FakeWebSocket.CLOSED;
      await Promise.all(
        (this.handlers.get('close') ?? []).map((handler) => handler(code, Buffer.from(reason))),
      );
    }

    close(code?: number, reason?: string): void {
      this.closeCalls.push([code, reason]);
    }

    send(data: string): void { this.sendCalls.push(data); }
    ping(): void { this.pingCalls += 1; }
    terminate(): void { this.terminateCalls += 1; }
  }

  return { WebSocket: FakeWebSocket };
});

import { MAX_AGENT_WS_FRAME_BYTES } from '@nyabase/common';
import { AgentWsClient } from './client.js';

describe('AgentWsClient initialization recovery', () => {
  afterEach(() => {
    vi.useRealTimers();
    fakeWs.sockets.length = 0;
    vi.restoreAllMocks();
  });

  it('closes the socket when connection initialization fails so reconnect can retry', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = new AgentWsClient({
      url: 'ws://backend.invalid/ws/agent',
      token: 'token',
      serverId: 'server-a',
      onConnect: async () => { throw new Error('hello probe failed'); },
    });

    client.start();
    const socket = fakeWs.sockets[0];
    socket.emitOpen();
    await flushMicrotasks();
    expect(socket.closeCalls).toEqual([]);
    await admit(socket);

    await vi.waitFor(() => {
      expect(socket.closeCalls).toContainEqual([4501, 'Agent initialization failed']);
    });
    client.stop();
  });

  it('keeps reconnect initialization maxConcurrency=1 and freshly observes the new generation', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let active = 0;
    let maxConcurrency = 0;
    const generations: number[] = [];
    const onConnect = vi.fn(async (generation: number) => {
      active += 1;
      maxConcurrency = Math.max(maxConcurrency, active);
      generations.push(generation);
      try {
        if (generation === 1) {
          await firstGate;
          throw new Error('stale generation failed after disconnect');
        }
      } finally {
        active -= 1;
      }
    });
    const client = new AgentWsClient({
      url: 'ws://backend.invalid/ws/agent',
      token: 'token',
      serverId: 'server-a',
      onConnect,
    });

    client.start();
    const first = fakeWs.sockets[0];
    first.emitOpen();
    await admit(first);
    await flushMicrotasks();
    expect(generations).toEqual([1]);

    const closed = first.emitClose();
    await vi.advanceTimersByTimeAsync(1_000);
    await closed;
    const second = fakeWs.sockets[1];
    second.emitOpen();
    await admit(second);
    await flushMicrotasks();

    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(maxConcurrency).toBe(1);

    releaseFirst();
    await flushMicrotasks();

    expect(generations).toEqual([1, 2]);
    expect(maxConcurrency).toBe(1);
    expect(second.closeCalls).toEqual([]);
    client.stop();
  });

  it('does not start another initializer while an older generation never settles', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const never = new Promise<void>(() => undefined);
    const onConnect = vi.fn(async () => never);
    const client = new AgentWsClient({
      url: 'ws://backend.invalid/ws/agent',
      token: 'token',
      serverId: 'server-a',
      onConnect,
    });

    client.start();
    const first = fakeWs.sockets[0];
    first.emitOpen();
    await admit(first);
    await flushMicrotasks();
    expect(onConnect).toHaveBeenCalledOnce();

    const closed = first.emitClose();
    await vi.advanceTimersByTimeAsync(1_000);
    await closed;
    const second = fakeWs.sockets[1];
    second.emitOpen();
    await admit(second);
    await flushMicrotasks();

    expect(onConnect).toHaveBeenCalledOnce();
    client.stop();
  });

  it('terminates a half-open socket after a missed pong deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = new AgentWsClient({
      url: 'ws://backend.invalid/ws/agent',
      token: 'token',
      serverId: 'server-a',
    });

    client.start();
    const socket = fakeWs.sockets[0];
    socket.emitOpen();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.pingCalls).toBe(1);
    expect(socket.terminateCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.terminateCalls).toBe(1);
    client.stop();
  });

  it('terminates instead of growing an unbounded outbound buffer', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = new AgentWsClient({
      url: 'ws://backend.invalid/ws/agent',
      token: 'token',
      serverId: 'server-a',
    });

    client.start();
    const socket = fakeWs.sockets[0];
    socket.emitOpen();
    await admit(socket);
    client.send({
      id: 'hello-a',
      ts: Date.now(),
      kind: 'hello',
      payload: {},
    } as never);
    socket.bufferedAmount = MAX_AGENT_WS_FRAME_BYTES + 1;
    client.send({
      id: 'heartbeat-a',
      ts: Date.now(),
      kind: 'heartbeat',
      payload: { serverId: 'server-a', uptime: 1 },
    });

    expect(socket.terminateCalls).toBe(1);
    client.stop();
  });

  it('leaves authoritative backpressure classification to the caller', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = new AgentWsClient({
      url: 'ws://backend.invalid/ws/agent',
      token: 'token',
      serverId: 'server-a',
    });

    client.start();
    const socket = fakeWs.sockets[0];
    socket.emitOpen();
    await admit(socket);
    expect(client.send({
      id: 'hello-a', ts: Date.now(), kind: 'hello', payload: {},
    } as never)).toBe(true);
    socket.bufferedAmount = MAX_AGENT_WS_FRAME_BYTES;

    expect(client.send({
      id: 'report-a',
      ts: Date.now(),
      kind: 'stateReport',
      payload: {},
    } as never)).toBe(false);
    expect(socket.terminateCalls).toBe(0);
    expect(socket.terminateCalls).toBe(0);
    expect(client.retireGeneration(
      client.connectionGeneration,
      1011,
      'Authoritative inventory transport unavailable',
    )).toBe(true);
    expect(socket.closeCalls).toContainEqual([1011, 'Authoritative inventory transport unavailable']);
    client.stop();
  });

  it('rejects one oversized frame without killing the channel needed for a small inventory fault', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = new AgentWsClient({
      url: 'ws://backend.invalid/ws/agent',
      token: 'token',
      serverId: 'server-a',
    });
    client.start();
    const socket = fakeWs.sockets[0];
    socket.emitOpen();
    await admit(socket);
    expect(client.send({
      id: 'hello-a', ts: Date.now(), kind: 'hello', payload: {},
    } as never)).toBe(true);

    expect(client.send({
      id: 'oversized',
      ts: Date.now(),
      kind: 'inventoryFault',
      payload: {
        serverId: 'server-a',
        code: 'AUTHORITATIVE_INVENTORY_FAILED',
        message: 'x'.repeat(MAX_AGENT_WS_FRAME_BYTES),
        observedAt: Date.now(),
      },
    })).toBe(false);
    expect(socket.terminateCalls).toBe(0);
    expect(client.send({
      id: 'fault',
      ts: Date.now(),
      kind: 'inventoryFault',
      payload: {
        serverId: 'server-a',
        code: 'AUTHORITATIVE_INVENTORY_TOO_LARGE',
        message: 'inventory exceeded the wire limit',
        observedAt: Date.now(),
      },
    })).toBe(true);
    expect(socket.sendCalls).toHaveLength(2);
    client.stop();
  });

  it('never lets admission or non-hello traffic overtake hello on a new connection', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const client = new AgentWsClient({
      url: 'ws://backend.invalid/ws/agent',
      token: 'token',
      serverId: 'server-a',
    });

    client.start();
    const socket = fakeWs.sockets[0];
    socket.emitOpen();
    const generation = client.connectionGeneration;
    expect(client.send({
      id: 'heartbeat-a', ts: Date.now(), kind: 'heartbeat',
      payload: { serverId: 'server-a', uptime: 1 },
    })).toBe(false);
    expect(socket.sendCalls).toEqual([]);

    expect(client.send({
      id: 'hello-before-admission', ts: Date.now(), kind: 'hello', payload: {},
    } as never, generation)).toBe(false);
    await admit(socket);
    expect(client.send({
      id: 'hello-a', ts: Date.now(), kind: 'hello', payload: {},
    } as never, generation)).toBe(true);
    expect(client.send({
      id: 'heartbeat-b', ts: Date.now(), kind: 'heartbeat',
      payload: { serverId: 'server-a', uptime: 1 },
    }, generation - 1)).toBe(false);
    expect(client.send({
      id: 'heartbeat-c', ts: Date.now(), kind: 'heartbeat',
      payload: { serverId: 'server-a', uptime: 1 },
    }, generation)).toBe(true);
    expect(socket.sendCalls).toHaveLength(2);
    client.stop();
  });

  it('retires only the generation whose authoritative observation failed', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const client = new AgentWsClient({
      url: 'ws://backend.invalid/ws/agent',
      token: 'token',
      serverId: 'server-a',
    });

    client.start();
    const socket = fakeWs.sockets[0];
    socket.emitOpen();
    const generation = client.connectionGeneration;

    expect(client.retireGeneration(generation - 1, 4502, 'stale')).toBe(false);
    expect(socket.closeCalls).toEqual([]);
    expect(client.retireGeneration(generation, 4502, 'Authoritative inventory failed')).toBe(true);
    expect(socket.closeCalls).toEqual([[4502, 'Authoritative inventory failed']]);
    client.stop();
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function admit(socket: { emitMessage(value: unknown): Promise<void> }): Promise<void> {
  await socket.emitMessage({
    ts: Date.now(),
    kind: 'admission.ready.v1',
    payload: { serverId: 'server-a' },
  });
}
