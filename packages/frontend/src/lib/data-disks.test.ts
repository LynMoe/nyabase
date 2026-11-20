import { describe, expect, it } from 'vitest';
import {
  FailureCode,
  ResourceLifecyclePhase,
  StoragePoolResizeFamily,
  type StoragePoolDto,
} from '@nyabase/common';
import { ApiError } from './api-error.js';
import {
  grantablePools,
  mountStatus,
  mountUnsupportedReason,
  parseMountPathInput,
  storageErrorMessage,
  userDiskState,
} from './data-disks.js';

describe('grantablePools', () => {
  const pool = (id: string, extra: Partial<StoragePoolDto> = {}) =>
    ({ id, serverId: 's1', registered: true, shareable: false, ...extra }) as StoragePoolDto;

  it('offers the registered local pools of the server, and keeps the ones the grant holds', () => {
    const pools = [
      pool('p1'),
      pool('p2', { serverId: 's2' }),
      pool('p3', { registered: false }),
      pool('p4', { shareable: true }),
    ];
    expect(grantablePools(pools, 's1').map((row) => row.id)).toEqual(['p1']);
    expect(grantablePools(pools, 's1', ['p3']).map((row) => row.id)).toEqual(['p1', 'p3']);
  });
});

describe('mountUnsupportedReason', () => {
  const ok = { registered: true, resizeFamily: StoragePoolResizeFamily.QuotaOnline, quotaEffective: true };

  it('accepts only registered pools with an effective online quota', () => {
    expect(mountUnsupportedReason(ok)).toBeNull();
    expect(mountUnsupportedReason({ ...ok, registered: false })).toMatch(/登记/);
    expect(mountUnsupportedReason({ ...ok, resizeFamily: StoragePoolResizeFamily.BlockBacked })).toMatch(/块设备/);
    expect(mountUnsupportedReason({ ...ok, quotaEffective: null })).toMatch(/配额未生效/);
  });
});

describe('parseMountPathInput', () => {
  it('reads empty as not a data disk and normalizes a path', () => {
    expect(parseMountPathInput('  ')).toEqual({ ok: true, value: null });
    expect(parseMountPathInput('/data1/')).toEqual({ ok: true, value: '/data1' });
    expect(parseMountPathInput('//mnt//meowfs')).toEqual({ ok: true, value: '/mnt/meowfs' });
  });

  it('refuses system directories, relative paths and dot segments', () => {
    for (const bad of ['/etc', '/var/lib/x', '/home', '/proc/x']) {
      const result = parseMountPathInput(bad);
      expect(result.ok, bad).toBe(false);
    }
    expect(parseMountPathInput('/etc')).toMatchObject({ ok: false, error: expect.stringMatching(/系统目录/) });
    expect(parseMountPathInput('data')).toMatchObject({ ok: false, error: expect.stringMatching(/绝对路径/) });
    expect(parseMountPathInput('/a/../b')).toMatchObject({ ok: false });
    expect(parseMountPathInput('/home/shared').ok).toBe(true);
  });
});

describe('mountStatus', () => {
  it('explains a mount parked on a non-empty path and a disk under maintenance', () => {
    expect(mountStatus({ bindState: 'blocked', maintenance: false })).toEqual({
      label: '未挂载',
      hint: '挂载点在容器里已有文件：清空或移走后重启容器即可挂载',
      tone: 'warning',
    });
    expect(mountStatus({ bindState: 'attached', maintenance: true }).hint).toBe('盘维护中，暂未挂载');
    expect(mountStatus({ bindState: 'attaching', maintenance: false })).toMatchObject({ label: '挂载中', tone: 'pending' });
    expect(mountStatus({ bindState: 'detaching', maintenance: true })).toMatchObject({ label: '卸载中', tone: 'pending' });
    expect(mountStatus({ bindState: 'attached', maintenance: false })).toMatchObject({ label: '已挂载', tone: 'ok' });
  });
});

describe('userDiskState', () => {
  const active = {
    needsAttention: false,
    lifecyclePhase: ResourceLifecyclePhase.Active,
    observedRevision: 1,
    revision: 1,
    failureCode: null,
  };

  it('reads the disk settings before the volume', () => {
    expect(userDiskState({ mountPath: null, maintenance: false }, active).label).toBe('未启用');
    expect(userDiskState({ mountPath: '/data1', maintenance: true }, active).label).toBe('维护中');
    expect(userDiskState({ mountPath: '/data1', maintenance: false }, undefined)).toMatchObject({ label: '准备中', pending: true });
    expect(userDiskState({ mountPath: '/data1', maintenance: false }, active)).toMatchObject({ label: '可用', variant: 'success' });
  });

  it('puts a volume needing attention first', () => {
    expect(userDiskState({ mountPath: null, maintenance: false }, { ...active, needsAttention: true }).variant).toBe('destructive');
  });
});

describe('storageErrorMessage', () => {
  const error = (code: string, details: Record<string, unknown> = {}) =>
    new ApiError(409, code, 'english', { code, message: 'english', details });

  it('words the storage refusals in Chinese', () => {
    expect(storageErrorMessage(error(FailureCode.StorageMountPathConflict, { mountPath: '/data' }))).toMatch(/\/data .*嵌套/);
    expect(storageErrorMessage(error(FailureCode.StorageMountUnsupported))).toMatch(/不能作为数据盘/);
    expect(storageErrorMessage(error(FailureCode.VolumeStillGranted))).toBe('仍有授权覆盖该盘，请先撤销授权。');
    expect(storageErrorMessage(error(FailureCode.VolumeRequiresUnbind))).toMatch(/仍挂载/);
    expect(storageErrorMessage(error(FailureCode.VolumeDeleteBackendUnreachable))).toMatch(/在线服务器/);
    expect(storageErrorMessage(error('SOMETHING_ELSE'))).toBe('english');
  });
});
