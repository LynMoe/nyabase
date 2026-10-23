import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { ProxyControlHeartbeat } from './proxy-control-heartbeat.js';

class FakeSocket extends EventEmitter {
  pings = 0;
  terminated = false;

  ping(): void {
    this.pings += 1;
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('ProxyControlHeartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pings live sockets and terminates one that stopped answering', async () => {
    vi.useFakeTimers();
    const live = new FakeSocket();
    const dead = new FakeSocket();
    const sockets = new Set([live, dead]);
    const heartbeat = new ProxyControlHeartbeat(
      () => sockets as unknown as Set<WebSocket>,
      1_000,
    );
    heartbeat.track(live as unknown as WebSocket);
    heartbeat.track(dead as unknown as WebSocket);
    heartbeat.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect([live.pings, dead.pings]).toEqual([1, 1]);
    live.emit('pong');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(live.terminated).toBe(false);
    expect(dead.terminated).toBe(true);
    expect(live.pings).toBe(2);
    sockets.delete(dead);

    // Any frame counts, not only pongs.
    live.emit('message', Buffer.from('{}'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(live.terminated).toBe(false);

    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(live.terminated).toBe(false);
    expect(live.pings).toBe(3);
  });
});
