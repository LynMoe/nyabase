import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { AGENT_PROTOCOL_VERSION, type AgentHostStatus } from '@nyabase/common';
import { AgentRequestError, BackendConnection, type AgentHandlers } from './backend-connection.js';

const SERVER_ID = '11111111-1111-4111-8111-111111111111';
const DIGEST = 'a'.repeat(64);
const STATUS: AgentHostStatus = {
  ipv6Guard: { present: true, error: null },
  firewall: { present: false, digest: null, error: null },
};
const servers: WebSocketServer[] = [];

async function listen(): Promise<{ server: WebSocketServer; url: string }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function handlersWith(overrides: Partial<AgentHandlers>, status: () => AgentHostStatus): AgentHandlers {
  return {
    hello: async () => ({
      type: 'hello',
      protocol: AGENT_PROTOCOL_VERSION,
      agentVersion: 'test',
      hostname: 'worker-1',
      incus: { serverVersion: '7.4', apiExtensions: [] },
      status: status(),
    }),
    incusHttp: vi.fn(),
    incusWebSocket: vi.fn(),
    collectMetrics: vi.fn(),
    applyFirewall: vi.fn(),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('backend control connection', () => {
  it('ends the session signal handed to stream requests when the control socket drops', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    server.on('connection', (socket) => {
      socket.once('message', () => {
        socket.send(JSON.stringify({ type: 'welcome', serverId: SERVER_ID }));
        socket.send(JSON.stringify({
          type: 'request',
          id: randomUUID(),
          method: 'incus.ws',
          params: { path: '/1.0/events', streamId: randomUUID() },
        }));
      });
    });
    let session: AbortSignal | undefined;
    let bridged!: () => void;
    const streamBridged = new Promise<void>((resolve) => {
      bridged = resolve;
    });
    const handlers: AgentHandlers = {
      hello: async () => ({
        type: 'hello',
        protocol: AGENT_PROTOCOL_VERSION,
        agentVersion: 'test',
        hostname: 'worker-1',
        incus: { serverVersion: '7.4', apiExtensions: [] },
        status: STATUS,
      }),
      incusHttp: vi.fn(),
      collectMetrics: vi.fn(),
      applyFirewall: vi.fn(),
      // The stream is bridged and the request completes; the stream lives on.
      incusWebSocket: async (_params, _signal, current) => {
        session ??= current;
        bridged();
      },
    };
    const stop = new AbortController();
    const connection = new BackendConnection({
      url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
      credential: () => 'nyak.x.y',
      handlers,
      log: () => undefined,
    });
    const running = connection.run(stop.signal);
    await streamBridged;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(session?.aborted).toBe(false);
    for (const client of server.clients) client.terminate();
    await vi.waitFor(() => expect(session?.aborted).toBe(true));
    stop.abort();
    await running;
  });

  it('hands firewall.apply params to the handler unchecked and answers its refusal without closing', async () => {
    const { server, url } = await listen();
    const frames: Array<Record<string, unknown>> = [];
    let closed = false;
    server.on('connection', (socket) => {
      socket.on('close', () => {
        closed = true;
      });
      socket.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        frames.push(frame);
        if (frame.type !== 'hello') return;
        socket.send(JSON.stringify({ type: 'welcome', serverId: SERVER_ID }));
        socket.send(JSON.stringify({ type: 'request', id: 'aa-1', method: 'firewall.apply', params: { digest: 'nope' } }));
        socket.send(JSON.stringify({ type: 'request', id: 'aa-2', method: 'firewall.apply', params: { digest: DIGEST, rules: [] } }));
      });
    });
    const applyFirewall = vi.fn(async (params: unknown) => {
      if ((params as { digest?: string }).digest !== DIGEST) throw new AgentRequestError('bad_request', 'invalid firewall document');
      return { digest: DIGEST };
    });
    const stop = new AbortController();
    const connection = new BackendConnection({
      url,
      credential: () => 'nyak.x.y',
      handlers: handlersWith({ applyFirewall }, () => STATUS),
      log: () => undefined,
    });
    const running = connection.run(stop.signal);
    await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'response')).toHaveLength(2));
    expect(applyFirewall.mock.calls.map(([params]) => params)).toEqual([{ digest: 'nope' }, { digest: DIGEST, rules: [] }]);
    const responses = Object.fromEntries(frames.filter((frame) => frame.type === 'response').map((frame) => [frame.id, frame]));
    expect(responses['aa-1']).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(responses['aa-2']).toMatchObject({ ok: true, result: { digest: DIGEST } });
    expect(closed).toBe(false);
    stop.abort();
    await running;
  });

  it('sends at most one status frame per interval, the latest, and only when it changed', async () => {
    const { server, url } = await listen();
    const statuses: AgentHostStatus[] = [];
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as { type: string; status: AgentHostStatus };
        if (frame.type === 'hello') socket.send(JSON.stringify({ type: 'welcome', serverId: SERVER_ID }));
        if (frame.type === 'status') statuses.push(frame.status);
      });
    });
    let current = STATUS;
    const disconnected = vi.fn();
    let welcomed!: () => void;
    const welcome = new Promise<void>((resolve) => {
      welcomed = resolve;
    });
    const stop = new AbortController();
    const connection = new BackendConnection({
      url,
      credential: () => 'nyak.x.y',
      handlers: handlersWith({}, () => current),
      status: () => current,
      log: (line) => {
        if (line.startsWith('connected')) welcomed();
      },
      statusIntervalMs: 300,
      onDisconnected: disconnected,
    });
    const running = connection.run(stop.signal);
    await welcome;
    // Unchanged since hello: nothing to send.
    connection.publishStatus();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(statuses).toEqual([]);
    const withDigest = (present: boolean): AgentHostStatus => ({ ...STATUS, firewall: { present, digest: DIGEST, error: null } });
    current = withDigest(false);
    connection.publishStatus();
    current = withDigest(true);
    connection.publishStatus();
    connection.publishStatus();
    await vi.waitFor(() => expect(statuses).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(statuses).toEqual([withDigest(false)]);
    // The trailing frame carries the latest status, once.
    await vi.waitFor(() => expect(statuses).toHaveLength(2));
    expect(statuses[1]).toEqual(withDigest(true));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(statuses).toHaveLength(2);
    expect(disconnected).not.toHaveBeenCalled();
    for (const client of server.clients) client.terminate();
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1));
    stop.abort();
    await running;
  });
});
