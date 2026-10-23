import { describe, expect, it } from 'vitest';
import { snapshotBuildFailureMessage } from './snapshot-build-failure.js';

describe('snapshotBuildFailureMessage', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');

  it('names the earliest lease end as the time proxies fail closed', () => {
    const message = snapshotBuildFailureMessage(
      'SSH',
      new Error('over the cap'),
      [now + 90_000, now + 30_500],
      now,
    );
    expect(message).toBe(
      'SSH proxy snapshot build failed: over the cap; proxies keep their last snapshot until '
      + '2026-01-01T00:00:30.500Z (31 s) and then fail closed until a build succeeds',
    );
  });

  it('says so when the leases have already run out or no proxy holds one', () => {
    expect(snapshotBuildFailureMessage('HTTP', 'boom', [now - 1], now)).toContain(
      'leases have run out; proxies fail closed',
    );
    expect(snapshotBuildFailureMessage('HTTP', 'boom', [], now)).toContain(
      'no connected proxy holds a snapshot',
    );
  });
});
