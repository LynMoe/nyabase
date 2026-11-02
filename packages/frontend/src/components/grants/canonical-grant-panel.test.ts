import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRANT_EXPIRY_GRACE_DAYS, type ServerGrantDto, type StoragePoolDto } from '@nyabase/common';
import { readSourceDir } from '../../lib/read-source.test-helper.js';
import { GIB } from '../../lib/utils.js';
import {
  addablePools,
  expiryLabel,
  expiryMinuteOptions,
  expiryPhase,
  gibQuotaText,
  parseGibQuotaKeeping,
  remainingLabel,
  toDatetimeLocalValue,
} from './use-grant-panel-data.js';

describe('toDatetimeLocalValue', () => {
  it('formats local calendar time without seconds or timezone', () => {
    const date = new Date(2026, 0, 15, 9, 5, 30);
    expect(toDatetimeLocalValue(date)).toBe('2026-01-15T09:05');
  });
});

describe('expiryPhase', () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(Date.now() - days * dayMs).toISOString();

  it('judges one grant by its own expiry: live, within the 14-day grace, or past it', () => {
    expect(expiryPhase(null)).toBe('live');
    expect(expiryPhase(new Date(Date.now() + dayMs).toISOString())).toBe('live');
    expect(expiryPhase(ago(1))).toBe('grace');
    expect(expiryPhase(ago(GRANT_EXPIRY_GRACE_DAYS - 1))).toBe('grace');
    expect(expiryPhase(ago(GRANT_EXPIRY_GRACE_DAYS + 1))).toBe('lost');
  });

  it('calls a grant without expiry 永久', () => {
    expect(expiryLabel(null)).toBe('永久');
  });
});

describe('remainingLabel', () => {
  const now = Date.parse('2026-11-02T00:00:00Z');
  const after = (ms: number) => new Date(now + ms).toISOString();

  it('reads whole days, hours in the last day and minutes in the last hour', () => {
    expect(remainingLabel(after(30 * 86_400_000 - 1), now)).toBe('29 天');
    expect(remainingLabel(after(86_400_000), now)).toBe('1 天');
    expect(remainingLabel(after(86_400_000 - 1), now)).toBe('23 小时');
    expect(remainingLabel(after(3_600_000 - 1), now)).toBe('59 分钟');
    expect(remainingLabel(after(1_000), now)).toBe('1 分钟');
  });

  it('is null once past', () => {
    expect(remainingLabel(after(0), now)).toBeNull();
    expect(remainingLabel(after(-1), now)).toBeNull();
  });
});

describe('expiryMinuteOptions', () => {
  it('offers five-minute steps and keeps an existing minute between them', () => {
    expect(expiryMinuteOptions('15')).toHaveLength(12);
    expect(expiryMinuteOptions('37')).toHaveLength(13);
    expect(expiryMinuteOptions('37').slice(7, 9)).toEqual(['35', '37']);
  });
});

describe('addablePools', () => {
  const pool = (id: string, serverId: string, extra: Partial<StoragePoolDto> = {}) =>
    ({ id, serverId, registered: true, shareable: false, ...extra }) as StoragePoolDto;
  const grant = { serverId: 's1', storagePools: [{ poolId: 'p1' }] } as unknown as ServerGrantDto;

  it('offers only registered local pools of the grant\'s server without a data disk yet', () => {
    const pools = [
      pool('p1', 's1'),
      pool('p2', 's1'),
      pool('p3', 's2'),
      pool('p4', 's1', { registered: false }),
      pool('p5', 's1', { shareable: true }),
    ];
    expect(addablePools(pools, grant).map((row) => row.id)).toEqual(['p2']);
  });
});

describe('parseGibQuotaKeeping', () => {
  it('keeps the stored limit while its text is untouched and parses anything typed', () => {
    const stored = GIB + 3;
    expect(gibQuotaText(stored)).toBe('1');
    expect(parseGibQuotaKeeping('1', stored)).toBe(stored);
    expect(parseGibQuotaKeeping('2', stored)).toBe(2 * GIB);
    expect(parseGibQuotaKeeping('', null)).toBeNull();
    expect(parseGibQuotaKeeping('1', undefined)).toBe(GIB);
    expect(parseGibQuotaKeeping('0', stored)).toBeUndefined();
  });
});

describe('grant panel copy', () => {
  const source = readSourceDir(join(fileURLToPath(new URL('.', import.meta.url)), '..'), 'grants');

  it('warns that deleting a server grant stops containers and purges after the grace', () => {
    expect(source).toContain('容器立即停止，${GRANT_EXPIRY_GRACE_DAYS} 天后清除');
  });

  it('warns that deleting a data disk force-detaches its volumes and deletes them after the grace', () => {
    expect(source).toContain('该池上的数据卷立即从容器强制卸载，${GRANT_EXPIRY_GRACE_DAYS} 天后删除');
  });

  it('asks before replacing the bundle a user already holds on a server', () => {
    expect(source).toContain('是否替换为');
    expect(source).toContain('替换后立即生效');
  });
});

describe('sameOverrides', () => {
  it('compares the overridden fields and their values; null (不限) is a value', async () => {
    const { sameOverrides } = await import('./server-grant-list.js');
    expect(sameOverrides({}, {})).toBe(true);
    expect(sameOverrides({ memBytes: null }, { memBytes: null })).toBe(true);
    expect(sameOverrides({ memBytes: null }, {})).toBe(false);
    expect(sameOverrides({ memBytes: 1 }, { memBytes: 2 })).toBe(false);
    expect(sameOverrides({ memBytes: 1 }, { memBytes: 1, cpuCores: 4 })).toBe(false);
  });
});
