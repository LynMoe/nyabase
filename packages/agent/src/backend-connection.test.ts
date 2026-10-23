import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { AGENT_PROTOCOL_VERSION } from '@nyabase/common';
import { BackendConnection, type AgentHandlers } from './backend-connection.js';

const SERVER_ID = '11111111-1111-4111-8111-111111111111';
const servers: WebSocketServer[] = [];

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
        status: { ipv6Guard: { present: true, error: null } },
        guestBridges: ['vmbr0'],
      }),
      incusHttp: vi.fn(),
      collectMetrics: vi.fn(),
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
});
