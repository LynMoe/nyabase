import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LogChunkPayload } from '@nyabase/common';
import { LogChunkTracker } from '../log-chunk-tracker.js';

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

  it('does not buffer standalone EOF chunks when no listener is registered', () => {
    tracker.dispatch(chunk({ eof: true, data: '' }));
    const cb = vi.fn();
    tracker.onLogChunk('sess-1', 'srv-1', cb);
    // Only call from the registration replay path, which would be empty
    expect(cb).not.toHaveBeenCalled();
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
});
