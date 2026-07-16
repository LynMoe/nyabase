import { describe, expect, it } from 'vitest';
import { MonotonicReuseGuard } from './monotonic-reuse-guard.js';

describe('MonotonicReuseGuard', () => {
  it('does not let a forward wall-clock jump shorten an armed drain', () => {
    let monotonicNow = 100;
    const guard = new MonotonicReuseGuard(() => monotonicNow, 1_000);
    guard.arm('network:claim-a');

    expect(guard.mayReuse('network:claim-a', new Date(200), 10_000)).toBe(false);
    monotonicNow = 1_099;
    expect(guard.mayReuse('network:claim-a', new Date(200), 10_000)).toBe(false);
    monotonicNow = 1_100;
    expect(guard.mayReuse('network:claim-a', new Date(200), 10_000)).toBe(true);
  });

  it('re-arms a full drain when an expired durable row is first observed after restart', () => {
    let monotonicNow = 50;
    const guard = new MonotonicReuseGuard(() => monotonicNow, 1_000);

    expect(guard.mayReuse('hostname:a.example.test', new Date(1), 10_000)).toBe(false);
    monotonicNow = 1_049;
    expect(guard.mayReuse('hostname:a.example.test', new Date(1), 10_000)).toBe(false);
    monotonicNow = 1_050;
    expect(guard.mayReuse('hostname:a.example.test', new Date(1), 10_000)).toBe(true);
  });

  it('restarts the full drain when an earlier pre-commit arm is followed by a later retry', () => {
    let monotonicNow = 100;
    const guard = new MonotonicReuseGuard(() => monotonicNow, 1_000);
    guard.arm('network:claim-a'); // surrounding transaction rolls back

    monotonicNow = 900;
    guard.arm('network:claim-a'); // later releasing transition commits
    monotonicNow = 1_100;
    expect(guard.mayReuse('network:claim-a', new Date(1), 10_000)).toBe(false);
    monotonicNow = 1_900;
    expect(guard.mayReuse('network:claim-a', new Date(1), 10_000)).toBe(true);
  });
});
