import { describe, expect, it, vi } from 'vitest';
import { CoalescedJob } from './coalesced-job.js';

describe('CoalescedJob', () => {
  it('keeps one active run and only the latest queued trigger', async () => {
    const job = new CoalescedJob();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];

    const first = job.run(async () => {
      calls.push('first');
      await gate;
    });
    const superseded = vi.fn(async () => { calls.push('superseded'); });
    const latest = vi.fn(async () => { calls.push('latest'); });
    expect(job.run(superseded)).toBe(first);
    expect(job.run(latest)).toBe(first);

    release();
    await first;
    expect(calls).toEqual(['first', 'latest']);
    expect(superseded).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });
});
