import { EventEmitter, getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { AGENT_PROTOCOL_VERSION, type AgentHello } from '@nyabase/common';
import {
  AGENT_STREAM_REPLY_TIMEOUT_MS,
  AGENT_STREAM_WAIT_TIMEOUT_MS,
  AgentConnection,
  AgentStreamBroker,
} from './agent-connection.js';
import { AGENT_CLOSE_REPLACED, AgentRegistry } from './agent-registry.service.js';
import { BufferedStreamSocket } from './agent-stream-socket.js';

const SERVER_ID = '11111111-1111-4111-8111-111111111111';
const HELLO: AgentHello = {
  type: 'hello',
  protocol: AGENT_PROTOCOL_VERSION,
  agentVersion: '0.1.0',
  hostname: 'worker-1',
  incus: { serverVersion: '7.4', apiExtensions: [] },
  status: { ipv6Guard: { present: true, error: null } },
};

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: Array<Record<string, unknown>> = [];
  closed?: { code: number; reason: string };

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.readyState = WebSocket.CLOSED;
  }

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
  }

  lastRequest(): { id: string; method: string; params: Record<string, unknown> } {
    const frame = [...this.sent].reverse().find((item) => item.type === 'request');
    return frame as unknown as { id: string; method: string; params: Record<string, unknown> };
  }
}

function connection(socket = new FakeSocket(), broker = new AgentStreamBroker()) {
  return { socket, broker, agent: new AgentConnection(SERVER_ID, HELLO, socket as unknown as WebSocket, broker) };
}

describe('agent connection RPC', () => {
  it('carries Incus requests as base64 frames and decodes the reply', async () => {
    const { socket, agent } = connection();
    const pending = agent.request({
      method: 'PUT',
      path: '/1.0/instances/nyc-0',
      headers: { 'If-Match': 'etag' },
      body: Buffer.from('{"a":1}'),
      timeoutMs: 5_000,
    });
    const request = socket.lastRequest();
    expect(request.method).toBe('incus.http');
    expect(request.params).toMatchObject({ method: 'PUT', path: '/1.0/instances/nyc-0', timeoutMs: 5_000 });
    expect(Buffer.from(String(request.params.body), 'base64').toString()).toBe('{"a":1}');
    expect(agent.handleFrame({
      type: 'response',
      id: request.id,
      ok: true,
      result: { status: 200, headers: { etag: 'next' }, body: Buffer.from('{"type":"sync"}').toString('base64') },
    })).toBe(true);
    await expect(pending).resolves.toEqual({
      status: 200,
      headers: { etag: 'next' },
      body: Buffer.from('{"type":"sync"}'),
    });
  });

  it('maps a policy refusal to a terminal Incus error', async () => {
    const { socket, agent } = connection();
    const pending = agent.request({ method: 'POST', path: '/1.0/certificates', headers: {}, timeoutMs: 1_000 });
    agent.handleFrame({
      type: 'response',
      id: socket.lastRequest().id,
      ok: false,
      error: { code: 'policy_denied', message: '/1.0/certificates is not reachable' },
    });
    await expect(pending).rejects.toMatchObject({ code: 'AGENT_POLICY_DENIED', disposition: 'managed_failure' });
  });

  it('cancels a request on timeout and on abort', async () => {
    vi.useFakeTimers();
    try {
      const { socket, agent } = connection();
      const timedOut = agent.request({ method: 'GET', path: '/1.0', headers: {}, timeoutMs: 100 }).catch((error) => error);
      const id = socket.lastRequest().id;
      await vi.advanceTimersByTimeAsync(2_200);
      await expect(timedOut).resolves.toMatchObject({ code: 'INCUS_TIMEOUT', disposition: 'retry' });
      expect(socket.sent).toContainEqual({ type: 'cancel', id });

      const controller = new AbortController();
      const aborted = agent.request({
        method: 'GET',
        path: '/1.0',
        headers: {},
        timeoutMs: 60_000,
        signal: controller.signal,
      }).catch((error) => error);
      const abortedId = socket.lastRequest().id;
      controller.abort();
      await expect(aborted).resolves.toMatchObject({ code: 'INCUS_TIMEOUT' });
      expect(socket.sent).toContainEqual({ type: 'cancel', id: abortedId });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails pending requests when the agent goes away', async () => {
    const { agent } = connection();
    const pending = agent.request({ method: 'GET', path: '/1.0', headers: {}, timeoutMs: 60_000 });
    agent.markClosed();
    await expect(pending).rejects.toMatchObject({ code: 'SERVER_UNREACHABLE', disposition: 'retry' });
    await expect(agent.request({ method: 'GET', path: '/1.0', headers: {}, timeoutMs: 1 }))
      .rejects.toMatchObject({ code: 'SERVER_UNREACHABLE' });
  });

  it('rejects frames that are not responses', () => {
    const { agent } = connection();
    expect(agent.handleFrame({ type: 'hello' })).toBe(false);
  });

  it('pairs the agent-opened stream socket and replays frames sent before anyone listened', async () => {
    const { socket, broker, agent } = connection();
    const opening = agent.openWebSocket('/1.0/events');
    const request = socket.lastRequest();
    expect(request.method).toBe('incus.ws');
    const streamId = String(request.params.streamId);
    const stream = new FakeSocket();
    expect(broker.accept(streamId, '22222222-2222-4222-8222-222222222222', stream as unknown as WebSocket)).toBe(false);
    expect(broker.accept(streamId, SERVER_ID, stream as unknown as WebSocket)).toBe(true);
    // The agent relays Incus output before its incus.ws reply arrives.
    stream.emit('message', Buffer.from('first'), true);
    stream.emit('message', Buffer.from('second'), true);
    agent.handleFrame({ type: 'response', id: request.id, ok: true, result: {} });
    const opened = await opening;
    const received: string[] = [];
    opened.on('message', (data) => received.push(String(data)));
    stream.emit('message', Buffer.from('third'), true);
    await Promise.resolve();
    expect(received).toEqual(['first', 'second', 'third']);
  });

  it('delivers a close that arrived while buffering after the buffered frames', async () => {
    const { socket, broker, agent } = connection();
    const opening = agent.openWebSocket('/1.0/events');
    const request = socket.lastRequest();
    const stream = new FakeSocket();
    broker.accept(String(request.params.streamId), SERVER_ID, stream as unknown as WebSocket);
    stream.emit('message', Buffer.from('last words'), false);
    stream.emit('close', 1000, Buffer.from('done'));
    agent.handleFrame({ type: 'response', id: request.id, ok: true, result: {} });
    const opened = await opening;
    const events: string[] = [];
    opened.on('message', (data) => events.push(`message:${String(data)}`));
    opened.on('close', (code) => events.push(`close:${String(code)}`));
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(['message:last words', 'close:1000']);
  });

  it('terminates a stream the agent connected when the incus.ws reply fails', async () => {
    const { socket, broker, agent } = connection();
    const opening = agent.openWebSocket('/1.0/events').catch((error) => error);
    const request = socket.lastRequest();
    const stream = Object.assign(new FakeSocket(), { terminate: vi.fn() });
    broker.accept(String(request.params.streamId), SERVER_ID, stream as unknown as WebSocket);
    agent.handleFrame({ type: 'response', id: request.id, ok: false, error: { code: 'internal', message: 'late' } });
    await expect(opening).resolves.toMatchObject({ code: 'AGENT_REQUEST_FAILED', disposition: 'retry' });
    expect(stream.terminate).toHaveBeenCalled();
  });

  it('closes its streams when the control connection goes away', async () => {
    const { socket, broker, agent } = connection();
    void agent.openWebSocket('/1.0/events').catch(() => undefined);
    const stream = new FakeSocket();
    broker.accept(String(socket.lastRequest().params.streamId), SERVER_ID, stream as unknown as WebSocket);
    agent.markClosed();
    expect(stream.closed?.code).toBe(1001);
    const late = new FakeSocket();
    void agent.openWebSocket('/1.0/events').catch(() => undefined);
    expect(broker.accept(String(socket.lastRequest().params.streamId), SERVER_ID, late as unknown as WebSocket))
      .toBe(false);
  });

  it('leaves no listener on a long-lived abort signal once each stream settles', async () => {
    const { socket, broker, agent } = connection();
    const lifetime = new AbortController();
    for (let index = 0; index < 20; index += 1) {
      const opening = agent.openWebSocket('/1.0/events', lifetime.signal);
      const request = socket.lastRequest();
      broker.accept(String(request.params.streamId), SERVER_ID, new FakeSocket() as unknown as WebSocket);
      agent.handleFrame({ type: 'response', id: request.id, ok: true, result: {} });
      await opening;
    }
    const failing = agent.openWebSocket('/1.0/events', lifetime.signal).catch((error) => error);
    agent.handleFrame({ type: 'response', id: socket.lastRequest().id, ok: false, error: { code: 'internal', message: 'x' } });
    await failing;
    expect(getEventListeners(lifetime.signal, 'abort')).toHaveLength(0);
    expect(broker.pendingCount).toBe(0);
  });

  it('fails a stream at once when its signal is already aborted', async () => {
    const broker = new AgentStreamBroker();
    const aborted = AbortSignal.abort();
    const { socket } = broker.expect({ serverId: SERVER_ID, isOpen: true, adopt: vi.fn() }, aborted);
    await expect(socket).rejects.toMatchObject({ code: 'INCUS_TIMEOUT' });
    expect(broker.pendingCount).toBe(0);
  });

  it('leaves no stream rejection unhandled when the agent never answers incus.ws', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    // Only timeouts are faked: Node reports unhandled rejections between real macrotasks.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const realTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    try {
      const { socket, broker, agent } = connection();
      const opening = agent.openWebSocket('/1.0/events').catch((error: unknown) => error);
      const request = socket.lastRequest();
      for (let elapsed = 0; elapsed <= AGENT_STREAM_WAIT_TIMEOUT_MS; elapsed += 1_000) {
        await vi.advanceTimersByTimeAsync(1_000);
        await realTurn();
        await realTurn();
      }
      await expect(opening).resolves.toMatchObject({
        code: 'INCUS_TIMEOUT',
        details: { reason: 'agent_response_timeout' },
      });
      expect(socket.sent).toContainEqual({ type: 'cancel', id: request.id });
      expect(broker.pendingCount).toBe(0);
      // A stream the agent connects late finds nobody waiting and is refused.
      expect(broker.accept(String(request.params.streamId), SERVER_ID, new FakeSocket() as unknown as WebSocket))
        .toBe(false);
      expect(unhandled).toEqual([]);
    } finally {
      vi.useRealTimers();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('times the stream out after the reply wait when the agent answers without connecting it', async () => {
    expect(AGENT_STREAM_WAIT_TIMEOUT_MS).toBeGreaterThan(AGENT_STREAM_REPLY_TIMEOUT_MS);
    vi.useFakeTimers();
    try {
      const { socket, broker, agent } = connection();
      const opening = agent.openWebSocket('/1.0/events').catch((error: unknown) => error);
      agent.handleFrame({ type: 'response', id: socket.lastRequest().id, ok: true, result: {} });
      await vi.advanceTimersByTimeAsync(AGENT_STREAM_WAIT_TIMEOUT_MS);
      await expect(opening).resolves.toMatchObject({
        code: 'INCUS_TIMEOUT',
        details: { phase: 'connect', reason: 'agent_stream_timeout' },
      });
      expect(broker.pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an agent-side failure as retryable without calling the server unreachable', async () => {
    const { socket, agent } = connection();
    const pending = agent.request({ method: 'GET', path: '/1.0', headers: {}, timeoutMs: 1_000 });
    agent.handleFrame({
      type: 'response',
      id: socket.lastRequest().id,
      ok: false,
      error: { code: 'internal', message: 'agent is at its concurrent request limit' },
    });
    await expect(pending).rejects.toMatchObject({ code: 'AGENT_REQUEST_FAILED', disposition: 'retry' });
  });

  it('retries a start the agent held back for its IPv6 guard', async () => {
    const { socket, agent } = connection();
    const pending = agent.request({ method: 'PUT', path: '/1.0/instances/nyc-0/state', headers: {}, timeoutMs: 1_000 });
    agent.handleFrame({
      type: 'response',
      id: socket.lastRequest().id,
      ok: false,
      error: { code: 'ipv6_guard_missing', message: 'the IPv6 guard is not in place' },
    });
    await expect(pending).rejects.toMatchObject({ code: 'AGENT_IPV6_GUARD_MISSING', disposition: 'retry' });
  });

  it('tracks the host status the agent reports after hello', () => {
    const onStatus = vi.fn();
    const agent = new AgentConnection(
      SERVER_ID,
      HELLO,
      new FakeSocket() as unknown as WebSocket,
      new AgentStreamBroker(),
      onStatus,
    );
    expect(agent.status.ipv6Guard.present).toBe(true);
    const lost = { ipv6Guard: { present: false, error: 'nft: table vanished' } };
    expect(agent.handleFrame({ type: 'status', status: lost })).toBe(true);
    expect(agent.status).toEqual(lost);
    expect(onStatus).toHaveBeenCalledWith(agent);
    expect(agent.handleFrame({ type: 'status', status: { ipv6Guard: { present: 'yes' } } })).toBe(false);
  });
});

describe('buffered stream socket', () => {
  function buffered(maxBytes: number, maxFrames: number) {
    const raw = Object.assign(new FakeSocket(), { terminate: vi.fn() });
    return { raw, stream: new BufferedStreamSocket(raw as unknown as WebSocket, maxBytes, maxFrames) };
  }

  async function listen(stream: BufferedStreamSocket): Promise<string[]> {
    const events: string[] = [];
    stream.on('message', (data) => events.push(`message:${String(data)}`));
    stream.on('error', (error) => events.push(`error:${(error as Error).message.split(' ').slice(0, 3).join(' ')}`));
    stream.on('close', (code) => events.push(`close:${String(code)}`));
    await new Promise((resolve) => setImmediate(resolve));
    return events;
  }

  it('holds frames up to its limits', async () => {
    const { raw, stream } = buffered(8, 2);
    raw.emit('message', Buffer.from('1234'), true);
    raw.emit('message', Buffer.from('5678'), true);
    expect(stream.bufferedCount).toBe(2);
    expect(raw.terminate).not.toHaveBeenCalled();
    expect(await listen(stream)).toEqual(['message:1234', 'message:5678']);
  });

  it('terminates with an error once unconsumed bytes exceed the cap', async () => {
    const { raw, stream } = buffered(8, 100);
    raw.emit('message', Buffer.from('12345'), true);
    raw.emit('message', [Buffer.from('67'), Buffer.from('89')], true);
    expect(raw.terminate).toHaveBeenCalledOnce();
    expect(stream.bufferedCount).toBe(0);
    // Whatever the dying socket still reports is dropped; the overflow is what callers see.
    raw.emit('message', Buffer.from('late'), true);
    raw.emit('close', 1006, Buffer.alloc(0));
    expect(await listen(stream)).toEqual(['error:agent stream buffered', 'close:1009']);
  });

  it('terminates once too many frames are held, telling a close-only listener', async () => {
    const { raw, stream } = buffered(1_000, 2);
    const closes: unknown[] = [];
    stream.once('close', (code) => closes.push(code));
    for (const frame of ['a', 'b', 'c']) raw.emit('message', Buffer.from(frame), false);
    expect(raw.terminate).toHaveBeenCalledOnce();
    await new Promise((resolve) => setImmediate(resolve));
    expect(closes).toEqual([1009]);
  });
});

describe('agent registry', () => {
  it('keeps one connection per server and resolves the current one per call', async () => {
    const registry = new AgentRegistry();
    const events: string[] = [];
    registry.onPresence({
      connected: (serverId) => {
        events.push(`up:${serverId}`);
      },
      disconnected: (serverId) => {
        events.push(`down:${serverId}`);
      },
    });
    const tunnel = registry.tunnel(SERVER_ID);
    await expect(tunnel.request({ method: 'GET', path: '/1.0', headers: {}, timeoutMs: 1 }))
      .rejects.toMatchObject({ code: 'SERVER_UNREACHABLE' });

    const first = connection();
    registry.register(first.agent);
    const second = connection();
    registry.register(second.agent);
    expect(first.socket.closed?.code).toBe(AGENT_CLOSE_REPLACED);
    registry.unregister(first.agent);
    expect(registry.isConnected(SERVER_ID)).toBe(true);

    void tunnel.request({ method: 'GET', path: '/1.0', headers: {}, timeoutMs: 1_000 }).catch(() => undefined);
    expect(second.socket.lastRequest().method).toBe('incus.http');

    registry.unregister(second.agent);
    expect(registry.isConnected(SERVER_ID)).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual([`up:${SERVER_ID}`, `up:${SERVER_ID}`, `down:${SERVER_ID}`]);
  });

  it('closes sockets that have not registered yet on disconnect', () => {
    const registry = new AgentRegistry();
    const early = { close: vi.fn() };
    const left = { close: vi.fn() };
    registry.trackPending(SERVER_ID, early);
    const untrack = registry.trackPending(SERVER_ID, left);
    untrack();
    registry.disconnect(SERVER_ID, 4401, 'credential revoked');
    expect(early.close).toHaveBeenCalledWith(4401, 'credential revoked');
    expect(left.close).not.toHaveBeenCalled();
  });
});
