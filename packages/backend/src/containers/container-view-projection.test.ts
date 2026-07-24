import { describe, expect, it } from 'vitest';
import {
  requesterSafeContainerFailure,
  requesterSafeSshError,
} from './container-view-projection.js';

describe('container requester projections', () => {
  it('never exposes Agent paths or untrusted codes through durable failure state', () => {
    const projected = requesterSafeContainerFailure(
      '/srv/private/runtime',
      'failed to open /var/lib/docker/overlay2/secret/diff',
    );
    expect(projected).toEqual({
      failureCode: 'container_failed',
      failureReason: 'The container operation failed; retry it or contact an administrator',
    });
    expect(JSON.stringify(projected)).not.toMatch(/srv\/private|var\/lib\/docker/);
  });

  it('preserves only Backend-owned error codes and replaces raw SSH diagnostics', () => {
    expect(requesterSafeContainerFailure('runtime_missing', '/host/path')).toMatchObject({
      failureCode: 'runtime_missing',
    });
    expect(requesterSafeContainerFailure('host.secret.device.sda', '/host/path')).toMatchObject({
      failureCode: 'container_failed',
    });
    expect(requesterSafeSshError('dropbear failed at /etc/dropbear/key')).toBe(
      'Container SSH synchronization failed',
    );
    expect(requesterSafeSshError(null)).toBeUndefined();
  });
});
