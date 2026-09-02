import { describe, expect, it } from 'vitest';
import { preferredDashboardServerId } from './dashboard-server-selection.js';

describe('dashboard metric server selection', () => {
  it('prefers the first online server', () => {
    expect(preferredDashboardServerId([
      { id: 'offline', status: 'offline' },
      { id: 'online-a', status: 'online' },
      { id: 'online-b', status: 'online' },
    ])).toBe('online-a');
  });

  it('falls back to the first known server', () => {
    expect(preferredDashboardServerId([{ id: 'offline', status: 'offline' }])).toBe('offline');
  });
});
