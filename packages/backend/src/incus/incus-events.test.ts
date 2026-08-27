import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import lifecycleEvent from './fixtures/event-lifecycle.json';
import { subscribeIncusEvents, type IncusEventWakeStream } from './incus-events.js';
import type { IncusWebSocketLike } from './incus-client.js';

class EventSocket extends EventEmitter {
  closed = false;

  send(_data: string | Buffer): void {
    return;
  }

  close(): void {
    this.closed = true;
  }
}

function waitForTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Incus event wake stream', () => {
  it('parses recorded events as wake hints and reconnects after disconnect', async () => {
    const sockets: EventSocket[] = [];
    const client = {
      dialWebSocket: async (): Promise<IncusWebSocketLike> => {
        const socket = new EventSocket();
        sockets.push(socket);
        return socket as unknown as IncusWebSocketLike;
      },
    };
    const stream: IncusEventWakeStream = subscribeIncusEvents(client, {
      initialReconnectMs: 1,
      maxReconnectMs: 4,
    });

    await waitForTurn();
    sockets[0].emit('message', JSON.stringify(lifecycleEvent));
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        kind: 'wake',
        reason: 'event',
        event: lifecycleEvent,
      },
      done: false,
    });

    const disconnected = stream.next();
    sockets[0].emit('close');
    await expect(disconnected).resolves.toMatchObject({
      value: { kind: 'wake', reason: 'disconnected' },
      done: false,
    });
    const reconnected = stream.next();
    await waitForTurn();
    await expect(reconnected).resolves.toMatchObject({
      value: { kind: 'wake', reason: 'reconnected' },
      done: false,
    });
    expect(sockets).toHaveLength(2);
    stream.close();
  });

  it('stops reconnecting and wakes pending consumers on AbortSignal', async () => {
    const controller = new AbortController();
    const sockets: EventSocket[] = [];
    const client = {
      dialWebSocket: async (): Promise<IncusWebSocketLike> => {
        const socket = new EventSocket();
        sockets.push(socket);
        return socket as unknown as IncusWebSocketLike;
      },
    };
    const stream = subscribeIncusEvents(client, {
      signal: controller.signal,
      initialReconnectMs: 1,
      maxReconnectMs: 4,
    });
    await waitForTurn();
    const pending = stream.next();
    controller.abort();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(sockets[0].closed).toBe(true);
    await waitForTurn();
    expect(sockets).toHaveLength(1);
  });
});
