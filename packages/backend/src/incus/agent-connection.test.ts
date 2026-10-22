import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { AgentHello } from '@nyabase/common';
import { AgentConnection, AgentStreamBroker } from './agent-connection.js';
import { AGENT_CLOSE_REPLACED, AgentRegistry } from './agent-registry.service.js';

const SERVER_ID = '11111111-1111-4111-8111-111111111111';
const HELLO: AgentHello = {
  type: 'hello',
  protocol: 1,
  agentVersion: '0.1.0',
  hostname: 'worker-1',
  incus: { serverVersion: '7.4', apiExtensions: [] },
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
});
