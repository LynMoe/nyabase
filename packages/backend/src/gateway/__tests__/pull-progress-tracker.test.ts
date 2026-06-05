import { describe, it, expect, vi } from 'vitest';
import type { PullProgressPayload } from '@nyabase/common';
import { PullProgressTracker } from '../pull-progress-tracker.js';

function pp(overrides: Partial<PullProgressPayload> = {}): PullProgressPayload {
  return {
    serverId: 'srv-1',
    dockerRef: 'ubuntu:22.04',
    status: 'pulling',
    progress: 50,
    message: 'Pulling layer...',
    ...overrides,
  };
}

describe('PullProgressTracker', () => {
  it('stores progress and fans out to listeners', () => {
    const tracker = new PullProgressTracker();
    const listener = vi.fn();
    tracker.onProgress(listener);

    tracker.handle(pp(), vi.fn());

    expect(tracker.progress.get('srv-1:ubuntu:22.04')).toBeDefined();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 'pulling' }));
  });

  it('calls onDone callback when status is done', () => {
    const tracker = new PullProgressTracker();
    const onDone = vi.fn();

    tracker.handle(pp({ status: 'done', progress: 100 }), onDone);

    expect(onDone).toHaveBeenCalledWith('srv-1');
  });

  it('does not call onDone for non-done statuses', () => {
    const tracker = new PullProgressTracker();
    const onDone = vi.fn();

    tracker.handle(pp({ status: 'pulling' }), onDone);
    tracker.handle(pp({ status: 'error', message: 'failed' }), onDone);

    expect(onDone).not.toHaveBeenCalled();
  });

  it('unsubscribe stops future deliveries', () => {
    const tracker = new PullProgressTracker();
    const listener = vi.fn();
    const unsub = tracker.onProgress(listener);
    unsub();

    tracker.handle(pp(), vi.fn());
    expect(listener).not.toHaveBeenCalled();
  });

  it('clearServer removes all progress entries for that server', () => {
    const tracker = new PullProgressTracker();
    tracker.handle(pp({ dockerRef: 'img-a' }), vi.fn());
    tracker.handle(pp({ dockerRef: 'img-b' }), vi.fn());
    tracker.handle(pp({ serverId: 'srv-2', dockerRef: 'img-c' }), vi.fn());

    tracker.clearServer('srv-1');

    expect(tracker.progress.get('srv-1:img-a')).toBeUndefined();
    expect(tracker.progress.get('srv-1:img-b')).toBeUndefined();
    expect(tracker.progress.get('srv-2:img-c')).toBeDefined();
  });
});
