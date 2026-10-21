import { describe, expect, it } from 'vitest';
import { backendLacksOnlineExecutor } from './storage-shrink.js';

describe('backendLacksOnlineExecutor', () => {
  it('uses the backend DTO flag so grant-only users are not treated as having an executor', () => {
    expect(backendLacksOnlineExecutor({ hasOnlineExecutor: false })).toBe(true);
    expect(backendLacksOnlineExecutor({ hasOnlineExecutor: true })).toBe(false);
  });
});
