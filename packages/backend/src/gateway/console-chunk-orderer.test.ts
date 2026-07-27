import type { LogChunkPayload } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import {
  ConsoleChunkOrderer,
  MAX_PENDING_CONSOLE_CHUNKS_PER_SESSION,
} from './console-chunk-orderer.js';

describe('ConsoleChunkOrderer', () => {
  it('keeps data and EOF in arrival order across asynchronous lease checks', async () => {
    const orderer = new ConsoleChunkOrderer();
    const observed: string[] = [];
    let releaseFirst!: () => void;
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const error = vi.fn();

    expect(orderer.enqueue(chunk('first'), async () => {
      await firstBarrier;
      observed.push('first');
    }, error)).toBe(true);
    expect(orderer.enqueue(chunk('second'), async () => {
      observed.push('second');
    }, error)).toBe(true);
    expect(orderer.enqueue(chunk('', true), async () => {
      observed.push('eof');
    }, error)).toBe(true);

    await Promise.resolve();
    expect(observed).toEqual([]);
    releaseFirst();
    await vi.waitFor(() => expect(observed).toEqual(['first', 'second', 'eof']));
    expect(error).not.toHaveBeenCalled();
  });

  it('bounds pending data while still admitting one ordered EOF', async () => {
    const orderer = new ConsoleChunkOrderer();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const error = vi.fn();
    let finishEof!: () => void;
    const eofFinished = new Promise<void>((resolve) => {
      finishEof = resolve;
    });
    for (let index = 0; index < MAX_PENDING_CONSOLE_CHUNKS_PER_SESSION; index += 1) {
      expect(orderer.enqueue(chunk(String(index)), () => barrier, error)).toBe(true);
    }
    expect(orderer.enqueue(chunk('overflow'), () => barrier, error)).toBe(false);
    expect(orderer.enqueue(chunk('', true), async () => {
      await barrier;
      finishEof();
    }, error)).toBe(true);
    expect(orderer.enqueue(chunk('after-eof'), () => barrier, error)).toBe(false);
    release();
    await eofFinished;
    expect(error).not.toHaveBeenCalled();
  });
});

function chunk(data: string, eof = false): LogChunkPayload {
  return {
    sessionId: 'session-a',
    data,
    ...(eof ? { eof: true, exitCode: 0 } : {}),
  };
}
