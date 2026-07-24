import { describe, expect, it } from 'vitest';
import { dashboardServerHasGpu, preferredDashboardServerId } from './dashboard-server-selection.js';

describe('dashboard metric server selection', () => {
  it('prefers a known GPU server even before any GPU usage sample exists', () => {
    const servers = [
      { id: 'cpu-online', status: 'online', hasGpu: false },
      { id: 'gpu-idle', status: 'online', hasGpu: true },
    ];
    expect(preferredDashboardServerId(servers)).toBe('gpu-idle');
    expect(dashboardServerHasGpu(servers[1]!)).toBe(true);
  });

  it('falls back to the first online server and then the first known server', () => {
    expect(preferredDashboardServerId([
      { id: 'offline', status: 'offline' },
      { id: 'online', status: 'online', hasGpu: false },
    ])).toBe('online');
    expect(preferredDashboardServerId([{ id: 'offline', status: 'offline' }])).toBe('offline');
  });
});
