import { describe, expect, it } from 'vitest';
import { sharedBackendAvailableBytes } from './utils.js';

describe('sharedBackendAvailableBytes', () => {
  // 271 TiB physical at 100×, 360 TiB already booked across owners (prod meowfs).
  const backend = { totalBytes: 271, usedBytes: 360, overcommitRatio: 100 };

  it('is the backend-wide room without an owner', () => {
    expect(sharedBackendAvailableBytes(backend)).toBe(26_740);
  });
  it('stops one owner at the physical total', () => {
    expect(sharedBackendAvailableBytes(backend, 0)).toBe(271);
    expect(sharedBackendAvailableBytes(backend, 200)).toBe(71);
    expect(sharedBackendAvailableBytes(backend, 300)).toBe(0);
  });
  it('keeps the backend-wide limit when it is the tighter one', () => {
    expect(sharedBackendAvailableBytes({ totalBytes: 100, usedBytes: 180, overcommitRatio: 2 }, 0)).toBe(20);
  });
  it('is unknown without capacity figures', () => {
    expect(sharedBackendAvailableBytes({ totalBytes: null, usedBytes: 0, overcommitRatio: 1 }, 0)).toBeNull();
  });
});
