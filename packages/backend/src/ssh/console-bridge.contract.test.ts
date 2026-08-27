import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ConsoleBridgeGateway } from '../runtime/console-bridge.gateway.js';
import { IncusConsoleBridgeAdapter } from '../runtime/incus-console-bridge.adapter.js';

class FakeSocket extends EventEmitter {
  readonly readyState = 1;
  readonly send = vi.fn();
  readonly close = vi.fn();
}

describe('Incus console bridge contract', () => {
  it('accepts the one authentication frame without logging or forwarding the secret', async () => {
    const gateway = new ConsoleBridgeGateway(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const socket = new FakeSocket();
    const firstAuthFrame = (gateway as unknown as {
      firstAuthFrame(value: FakeSocket): Promise<string>;
    }).firstAuthFrame.bind(gateway);
    const pending = firstAuthFrame(socket);

    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'auth',
      token: 'one-time-console-secret',
    })));

    await expect(pending).resolves.toBe('one-time-console-secret');
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('opens a direct Incus exec websocket and does not create an Agent task', async () => {
    const openExecWebSockets = vi.fn().mockResolvedValue({
      sockets: {},
      close: vi.fn(),
    });
    const adapter = new IncusConsoleBridgeAdapter();

    await adapter.open(
      { openExecWebSockets } as never,
      'nyc-container-1',
      ['bash'],
      { tty: true, width: 120, height: 40 },
    );

    expect(openExecWebSockets).toHaveBeenCalledWith(
      'nyc-container-1',
      expect.objectContaining({
        command: ['bash'],
        interactive: true,
        'wait-for-websocket': true,
        width: 120,
        height: 40,
      }),
      expect.objectContaining({
        channels: ['0', 'control'],
      }),
    );
  });
});
