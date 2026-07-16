import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LogChunkPayload } from '@nyabase/common';
import {
  LogChunkTracker,
  MAX_BUFFERED_DATA_CHARS_PER_SESSION,
  MAX_BUFFERED_LOG_DATA_CHARS,
  MAX_LOG_LISTENERS_PER_SERVER,
} from '../log-chunk-tracker.js';

function chunk(overrides: Partial<LogChunkPayload> = {}): LogChunkPayload {
  return { sessionId: 'sess-1', data: 'hello', ...overrides };
}

describe('LogChunkTracker', () => {
  let tracker: LogChunkTracker;

  beforeEach(() => {
    tracker = new LogChunkTracker();
    tracker.start();
  });

  afterEach(() => {
    tracker.stop();
  });

  it('dispatches a chunk to a registered listener immediately', () => {
    const cb = vi.fn();
    tracker.onLogChunk('sess-1', 'srv-1', cb);
    tracker.dispatch(chunk());
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1', data: 'hello' }));
  });

  it('buffers chunks when no listener is registered and replays on subscribe', () => {
    tracker.dispatch(chunk({ data: 'first' }));
    tracker.dispatch(chunk({ data: 'second' }));

    const received: string[] = [];
    tracker.onLogChunk('sess-1', 'srv-1', (c) => received.push(c.data));

    expect(received).toEqual(['first', 'second']);
  });

  it('replays buffered chunks then continues with live chunks', () => {
    tracker.dispatch(chunk({ data: 'buffered' }));

    const received: string[] = [];
    tracker.onLogChunk('sess-1', 'srv-1', (c) => received.push(c.data));

    tracker.dispatch(chunk({ data: 'live' }));
    expect(received).toEqual(['buffered', 'live']);
  });

  it('buffers standalone EOF chunks until the listener is registered', () => {
    tracker.dispatch(chunk({ eof: true, data: '' }));
    const cb = vi.fn();
    tracker.onLogChunk('sess-1', 'srv-1', cb);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ eof: true }));
  });

  it('removes listener after eof is dispatched', () => {
    const cb = vi.fn();
    tracker.onLogChunk('sess-1', 'srv-1', cb);
    tracker.dispatch(chunk({ eof: true, data: '' }));
    // listener should have been cleaned up; further dispatch should not invoke cb
    tracker.dispatch(chunk({ data: 'after-eof' }));
    expect(cb).toHaveBeenCalledTimes(1); // only the eof chunk
  });

  it('unsubscribe function removes listener without receiving further chunks', () => {
    const cb = vi.fn();
    const unsub = tracker.onLogChunk('sess-1', 'srv-1', cb);
    unsub();
    tracker.dispatch(chunk({ data: 'after-unsub' }));
    expect(cb).not.toHaveBeenCalled();
  });

  it('clearServer sends synthetic EOF to all active listeners for that server', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    tracker.onLogChunk('sess-1', 'srv-1', cb1);
    tracker.onLogChunk('sess-2', 'srv-1', cb2);

    tracker.clearServer('srv-1');

    expect(cb1).toHaveBeenCalledWith(expect.objectContaining({ eof: true }));
    expect(cb2).toHaveBeenCalledWith(expect.objectContaining({ eof: true }));
  });

  it('clearServer does not affect listeners on other servers', () => {
    const cb = vi.fn();
    tracker.onLogChunk('sess-1', 'srv-2', cb);
    tracker.clearServer('srv-1');
    expect(cb).not.toHaveBeenCalled();
  });

  it('replays a fast terminal chunk that arrived before the browser listener', () => {
    const cb = vi.fn();
    tracker.dispatch({
      sessionId: 'fast-exit',
      data: '',
      eof: true,
      exitCode: 0,
    });

    tracker.onLogChunk('fast-exit', 'srv-1', cb);

    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ eof: true, exitCode: 0 }));
  });

  it('rejects listeners beyond the per-server cap', () => {
    const unsubscribers = Array.from({ length: MAX_LOG_LISTENERS_PER_SERVER }, (_, index) =>
      tracker.onLogChunk(`sess-${index}`, 'srv-1', vi.fn()));
    expect(() => tracker.onLogChunk('overflow', 'srv-1', vi.fn())).toThrow('Server log listener limit');
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  });

  it('evicts old pre-listener output at the global character budget', () => {
    const data = 'x'.repeat(MAX_BUFFERED_DATA_CHARS_PER_SESSION);
    const sessionCount = Math.floor(MAX_BUFFERED_LOG_DATA_CHARS / data.length);
    for (let index = 0; index < sessionCount; index += 1) {
      tracker.dispatch(chunk({ sessionId: `buffer-${index}`, data }));
    }
    tracker.dispatch(chunk({ sessionId: 'newest', data: 'y' }));

    const oldest = vi.fn();
    const newest = vi.fn();
    tracker.onLogChunk('buffer-0', 'srv-1', oldest);
    tracker.onLogChunk('newest', 'srv-1', newest);

    expect(oldest).not.toHaveBeenCalled();
    expect(newest).toHaveBeenCalledWith(expect.objectContaining({ data: 'y' }));
  });

  it('drops a single pre-listener chunk above the per-session budget', () => {
    tracker.dispatch(chunk({ data: 'x'.repeat(MAX_BUFFERED_DATA_CHARS_PER_SESSION + 1) }));
    const cb = vi.fn();
    tracker.onLogChunk('sess-1', 'srv-1', cb);
    expect(cb).not.toHaveBeenCalled();
  });
});
