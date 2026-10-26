import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatShortTime,
  sortedCounts,
  sshHistoryLabel,
  sshSessionPath,
  sshSessionStatsPath,
  sshSessionsPath,
} from './ssh-sessions.js';

describe('ssh session helpers', () => {
  it('labels known codes and passes unknown ones through', () => {
    expect(sshHistoryLabel('rejected_permit')).toBe('转发到非 22 端口（-L / -D）');
    expect(sshHistoryLabel('something_new')).toBe('something_new');
  });

  it('builds paths that only name scope=all explicitly', () => {
    expect(sshSessionsPath('mine', { containerId: 'c1' }, { limit: 20 })).toBe('/ssh-sessions?limit=20&containerId=c1');
    expect(sshSessionsPath('all', { state: 'open', peerIp: '' }, { limit: 50, cursor: 'x' }))
      .toBe('/ssh-sessions?scope=all&limit=50&cursor=x&state=open');
    expect(sshSessionPath('all', 'id')).toBe('/ssh-sessions/id?scope=all');
    expect(sshSessionStatsPath('mine', 30)).toBe('/ssh-sessions/stats?days=30');
  });

  it('formats durations', () => {
    const start = '2026-10-26T00:00:00.000Z';
    expect(formatDuration(start, '2026-10-26T00:00:42.000Z')).toBe('42 秒');
    expect(formatDuration(start, '2026-10-26T01:05:00.000Z')).toBe('1 小时 5 分');
    expect(formatDuration(start, '2026-10-28T03:00:00.000Z')).toBe('2 天 3 小时');
    expect(formatDuration(start, null, new Date('2026-10-26T00:10:00.000Z').getTime())).toBe('10 分');
  });

  it('formats table times compactly, with the year only when it differs', () => {
    const now = new Date(2026, 9, 26, 12, 0, 0);
    expect(formatShortTime(new Date(2026, 9, 26, 9, 5, 7).toISOString(), now)).toBe('10/26 09:05:07');
    expect(formatShortTime(new Date(2025, 0, 2, 3, 4, 5).toISOString(), now)).toBe('2025/1/2 03:04:05');
  });

  it('sorts counts largest first', () => {
    expect(sortedCounts({ a: 1, b: 3, c: 1 })).toEqual([['b', 3], ['a', 1], ['c', 1]]);
  });
});
