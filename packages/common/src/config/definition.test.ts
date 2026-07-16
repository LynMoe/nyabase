import { describe, expect, it } from 'vitest';
import {
  SSH_PROXY_SNAPSHOT_STALE_MAX_MS,
  SSH_PROXY_SNAPSHOT_STALE_MIN_MS,
} from '../constants.js';
import { controlPlaneConfigDefinitions } from './definition.js';

describe('SSH proxy snapshot lease configuration', () => {
  it('bounds leases by Agent report freshness and fail-closed recovery', () => {
    const field = controlPlaneConfigDefinitions.find(
      (definition) => definition.key === 'ssh.proxySnapshotStaleMs',
    );
    expect(field?.schema.safeParse(SSH_PROXY_SNAPSHOT_STALE_MIN_MS - 1).success).toBe(false);
    expect(field?.schema.safeParse(SSH_PROXY_SNAPSHOT_STALE_MIN_MS).success).toBe(true);
    expect(field?.schema.safeParse(SSH_PROXY_SNAPSHOT_STALE_MAX_MS).success).toBe(true);
    expect(field?.schema.safeParse(SSH_PROXY_SNAPSHOT_STALE_MAX_MS + 1).success).toBe(false);
  });
});

describe('proxy token configuration', () => {
  it.each(['http.proxyToken', 'ssh.proxyToken'])('%s accepts only canonical ASCII tokens', (key) => {
    const field = controlPlaneConfigDefinitions.find((definition) => definition.key === key);
    expect(field?.schema.safeParse('').success).toBe(true);
    expect(field?.schema.safeParse('a'.repeat(32)).success).toBe(true);
    expect(field?.schema.safeParse('a'.repeat(31)).success).toBe(false);
    expect(field?.schema.safeParse(`${'a'.repeat(32)} internal`).success).toBe(false);
    expect(field?.schema.safeParse(`é${'a'.repeat(32)}`).success).toBe(false);
  });
});
