import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { AGENT_PROTOCOL_VERSION } from '@nyabase/common';
import { AgentGateway } from './agent-gateway.js';
import { AgentRegistry } from './agent-registry.service.js';

const SERVER_ID = '11111111-1111-4111-8111-111111111111';
const HELLO = {
  type: 'hello',
  protocol: AGENT_PROTOCOL_VERSION,
  agentVersion: '0.1.0',
  hostname: 'worker-1',
  incus: { serverVersion: '7.4', apiExtensions: [] },
  status: { ipv6Guard: { present: true, error: null } },
};

class FakeControlSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: unknown[] = [];
  closed?: { code: number; reason: string };

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.readyState = WebSocket.CLOSING;
    queueMicrotask(() => {
      this.readyState = WebSocket.CLOSED;
      this.emit('close', code, Buffer.from(reason));
    });
  }

  ping(): void {}

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

/** Run the gateway's control acceptance on a fake socket, as if the upgrade succeeded. */
function acceptControl(confirm: () => Promise<boolean>) {
  const registry = new AgentRegistry();
  const confirmControl = vi.fn(confirm);
  const gateway = new AgentGateway(registry, { authenticate: vi.fn(), confirmControl } as never);
  const ws = new FakeControlSocket();
  (gateway as unknown as { acceptControl(ws: unknown, serverId: string, authorization: string): void })
    .acceptControl(ws, SERVER_ID, 'Bearer nyak.x.y');
  return { registry, ws, confirmControl };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class FakeUpgradeSocket extends EventEmitter {
  destroyed = false;
  ended?: string;

  destroy(): void {
    this.destroyed = true;
  }

  end(data: string): void {
    this.ended = data;
  }
}

describe('agent gateway upgrade', () => {
  it('survives a socket reset while the credential is being checked', async () => {
    let finish!: (serverId: string | undefined) => void;
    const credentials = { authenticate: vi.fn(() => new Promise<string | undefined>((resolve) => { finish = resolve; })) };
    const gateway = new AgentGateway(new AgentRegistry(), credentials as never);
    const server = new EventEmitter();
    gateway.attachToHttpServer(server as unknown as http.Server);
    const socket = new FakeUpgradeSocket();
    server.emit('upgrade', { url: '/ws/agent', headers: { authorization: 'Bearer x' } }, socket, Buffer.alloc(0));
    // Without a listener this 'error' would throw and take the process down.
    expect(() => socket.emit('error', new Error('ECONNRESET'))).not.toThrow();
    expect(socket.destroyed).toBe(true);
    finish('11111111-1111-4111-8111-111111111111');
    await new Promise((resolve) => setImmediate(resolve));
    expect(socket.ended).toBeUndefined();
    gateway.onModuleDestroy();
  });

  it('stops looking up credentials for an address that keeps failing', async () => {
    const authenticate = vi.fn().mockResolvedValue(undefined);
    const gateway = new AgentGateway(new AgentRegistry(), { authenticate } as never);
    const server = new EventEmitter();
    gateway.attachToHttpServer(server as unknown as http.Server, { trustProxy: () => false });
    const attempt = async () => {
      const socket = new FakeUpgradeSocket();
      server.emit('upgrade', {
        url: '/ws/agent',
        headers: { authorization: 'Bearer nyak.x.y' },
        socket: { remoteAddress: '198.51.100.7' },
      }, socket, Buffer.alloc(0));
      await new Promise((resolve) => setImmediate(resolve));
      return socket.ended;
    };
    for (let index = 0; index < 30; index += 1) expect(await attempt()).toMatch(/^HTTP\/1\.1 401/);
    expect(await attempt()).toMatch(/^HTTP\/1\.1 429/);
    expect(authenticate).toHaveBeenCalledTimes(30);
    // The client address goes along, so a refused credential can be traced to its host.
    expect(authenticate).toHaveBeenLastCalledWith('Bearer nyak.x.y', '198.51.100.7');
    gateway.onModuleDestroy();
  });

  it('answers 401 to a credential that does not resolve to a server', async () => {
    const gateway = new AgentGateway(new AgentRegistry(), { authenticate: vi.fn().mockResolvedValue(undefined) } as never);
    const server = new EventEmitter();
    gateway.attachToHttpServer(server as unknown as http.Server);
    const socket = new FakeUpgradeSocket();
    server.emit('upgrade', { url: '/ws/agent/stream?id=x', headers: {} }, socket, Buffer.alloc(0));
    await new Promise((resolve) => setImmediate(resolve));
    expect(socket.ended).toMatch(/^HTTP\/1\.1 401/);
    gateway.onModuleDestroy();
  });
});

describe('agent gateway hello', () => {
  it('registers only after the credential is re-verified', async () => {
    const { registry, ws, confirmControl } = acceptControl(async () => true);
    ws.emit('message', Buffer.from(JSON.stringify(HELLO)), false);
    expect(registry.isConnected(SERVER_ID)).toBe(false);
    await settle();
    expect(confirmControl).toHaveBeenCalledWith(SERVER_ID, 'Bearer nyak.x.y');
    expect(ws.sent).toEqual([{ type: 'welcome', serverId: SERVER_ID }]);
    expect(registry.isConnected(SERVER_ID)).toBe(true);
  });

  it('closes with 4401 when the credential was rotated or the server deleted after the upgrade', async () => {
    const { registry, ws } = acceptControl(async () => false);
    ws.emit('message', Buffer.from(JSON.stringify(HELLO)), false);
    await settle();
    expect(ws.closed?.code).toBe(4401);
    expect(ws.sent).toEqual([]);
    expect(registry.isConnected(SERVER_ID)).toBe(false);
  });

  it('lets disconnect reach a socket still waiting for hello or its verification', async () => {
    let finish!: (valid: boolean) => void;
    const { registry, ws } = acceptControl(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    ws.emit('message', Buffer.from(JSON.stringify(HELLO)), false);
    registry.disconnect(SERVER_ID);
    expect(ws.closed?.code).toBe(4401);
    finish(true);
    await settle();
    expect(ws.sent).toEqual([]);
    expect(registry.isConnected(SERVER_ID)).toBe(false);
  });

  it('refuses a second frame while hello is being verified', async () => {
    const { ws } = acceptControl(() => new Promise<boolean>(() => undefined));
    ws.emit('message', Buffer.from(JSON.stringify(HELLO)), false);
    ws.emit('message', Buffer.from(JSON.stringify(HELLO)), false);
    expect(ws.closed?.code).toBe(1008);
  });

  it('closes on an oversized frame before parsing it', () => {
    const { ws, confirmControl } = acceptControl(async () => true);
    ws.emit('message', Buffer.alloc(600 * 1024, 0x20), false);
    expect(ws.closed?.code).toBe(1009);
    expect(confirmControl).not.toHaveBeenCalled();
  });

  it('turns away a hello of another protocol and reports why', async () => {
    const { registry, ws, confirmControl } = acceptControl(async () => true);
    const refused = vi.fn();
    registry.onPresence({ connected: vi.fn(), disconnected: vi.fn(), refused });
    ws.emit('message', Buffer.from(JSON.stringify({ ...HELLO, protocol: 1, agentVersion: '0.1.0+gold' })), false);
    expect(ws.closed?.code).toBe(4426);
    expect(confirmControl).not.toHaveBeenCalled();
    expect(refused).toHaveBeenCalledWith(SERVER_ID, expect.stringContaining('0.1.0+gold speaks protocol 1'));
    expect(registry.isConnected(SERVER_ID)).toBe(false);
  });
});
