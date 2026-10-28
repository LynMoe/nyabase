import type { GrantServerProfileDto } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { serverProfileRows } from './grant-server-profile.js';

const GIB = 1024 ** 3;

const profile: GrantServerProfileDto = {
  serverId: 's1',
  live: true,
  cpu: { models: [{ name: 'Intel Xeon 8358', sockets: 2 }], logical: 128, reserved: 2, allocatable: 126 },
  memoryBytes: 1024 * GIB,
  pools: [
    { poolId: 'p1', name: 'nyabase-zfs', driver: 'zfs', system: true, totalBytes: 3000 * GIB, usedBytes: 120 * GIB },
    { poolId: 'p2', name: 'data', driver: 'dir', system: false, totalBytes: null, usedBytes: null },
  ],
  gpu: {
    enabled: true,
    cards: [
      { pciAddress: 'a', model: 'NVIDIA A800 80GB' },
      { pciAddress: 'b', model: 'NVIDIA A800 80GB' },
    ],
  },
};

describe('serverProfileRows', () => {
  it('summarises CPU, memory, pools and GPUs', () => {
    expect(serverProfileRows(profile)).toEqual([
      { label: 'CPU', value: '128 线程 · 可分配 126 · 保留 2', detail: '2 × Intel Xeon 8358' },
      { label: '内存', value: '1024 GiB' },
      { label: '系统盘池', value: '已用 120 GiB / 共 3000 GiB', detail: 'nyabase-zfs（zfs）' },
      { label: '数据盘池', value: '容量未知', detail: 'data（dir）' },
      { label: 'GPU', value: '2 张', detail: '2 × NVIDIA A800 80GB' },
    ]);
  });

  it('says what is unknown while the server is unreachable', () => {
    const rows = serverProfileRows({
      ...profile,
      live: false,
      cpu: { models: [], logical: null, reserved: 0, allocatable: null },
      memoryBytes: null,
      pools: [],
      gpu: { enabled: false, cards: [{ pciAddress: 'a', model: null }] },
    });
    expect(rows).toEqual([
      { label: 'CPU', value: '拓扑未上报' },
      { label: '内存', value: '未知' },
      { label: '系统盘池', value: '未设置' },
      { label: 'GPU', value: '1 张（未启用 GPU）' },
    ]);
  });
});
