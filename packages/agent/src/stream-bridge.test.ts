import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { bridgeSockets } from './stream-bridge.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closedWith?: number;
  terminated = false;
  pings = 0;

  send(data: Buffer): void {
    this.sent.push(String(data));
  }

  ping(): void {
    this.pings += 1;
  }

  close(code: number): void {
    this.closedWith = code;
    this.readyState = WebSocket.CLOSED;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }
}

const asSocket = (socket: FakeSocket): WebSocket => socket as unknown as WebSocket;

describe('stream bridge', () => {
  it('sends what Incus said before the bridge existed first', () => {
    const incus = new FakeSocket();
    const backend = new FakeSocket();
    bridgeSockets(asSocket(incus), asSocket(backend), {
      frames: [[Buffer.from('prompt$ '), true]],
      closed: false,
    });
    incus.emit('message', Buffer.from('later'), true);
    expect(backend.sent).toEqual(['prompt$ ', 'later']);
  });

  it('closes the Backend side when Incus closed before the bridge', () => {
    const incus = new FakeSocket();
    incus.readyState = WebSocket.CLOSED;
    const backend = new FakeSocket();
    bridgeSockets(asSocket(incus), asSocket(backend), { frames: [[Buffer.from('bye'), false]], closed: true });
    expect(backend.sent).toEqual(['bye']);
    expect(backend.closedWith).toBe(1000);
  });

  it('closes both sides when the control session ends', () => {
    const incus = new FakeSocket();
    const backend = new FakeSocket();
    const session = new AbortController();
    bridgeSockets(asSocket(incus), asSocket(backend), undefined, { session: session.signal });
    expect(incus.closedWith).toBeUndefined();
    session.abort();
    expect(incus.closedWith).toBe(1001);
    expect(backend.closedWith).toBe(1001);
  });

  it('does not bridge at all for a session that already ended', () => {
    const incus = new FakeSocket();
    const backend = new FakeSocket();
    bridgeSockets(asSocket(incus), asSocket(backend), undefined, { session: AbortSignal.abort() });
    expect(incus.readyState).toBe(WebSocket.CLOSED);
    expect(backend.readyState).toBe(WebSocket.CLOSED);
  });
});

describe('stream bridge heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops a bridge whose Backend side stops answering pings', () => {
    vi.useFakeTimers();
    const incus = new FakeSocket();
    const backend = new FakeSocket();
    bridgeSockets(asSocket(incus), asSocket(backend), undefined, { heartbeatMs: 1_000 });
    vi.advanceTimersByTime(1_000);
    expect(backend.pings).toBe(1);
    backend.emit('pong');
    vi.advanceTimersByTime(1_000);
    expect(backend.pings).toBe(2);
    expect(incus.readyState).toBe(WebSocket.OPEN);
    // No pong for a whole interval: the link is half-open.
    vi.advanceTimersByTime(1_000);
    expect(backend.terminated).toBe(true);
    expect(incus.closedWith).toBe(1001);
    // The timer is gone once the bridge closed.
    vi.advanceTimersByTime(5_000);
    expect(backend.pings).toBe(2);
  });

  it('counts Backend traffic as liveness', () => {
    vi.useFakeTimers();
    const incus = new FakeSocket();
    const backend = new FakeSocket();
    bridgeSockets(asSocket(incus), asSocket(backend), undefined, { heartbeatMs: 1_000 });
    for (let index = 0; index < 5; index += 1) {
      vi.advanceTimersByTime(1_000);
      backend.emit('message', Buffer.from('keys'), true);
    }
    expect(incus.sent).toHaveLength(5);
    expect(backend.terminated).toBe(false);
  });
});
