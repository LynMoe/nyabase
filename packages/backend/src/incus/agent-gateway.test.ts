import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { AgentGateway } from './agent-gateway.js';
import { AgentRegistry } from './agent-registry.service.js';

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
