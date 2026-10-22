import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { bridgeSockets } from './stream-bridge.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closedWith?: number;

  send(data: Buffer): void {
    this.sent.push(String(data));
  }

  close(code: number): void {
    this.closedWith = code;
    this.readyState = WebSocket.CLOSED;
  }

  terminate(): void {
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
});
