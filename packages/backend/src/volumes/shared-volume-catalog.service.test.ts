import { describe, expect, it, vi } from 'vitest';
import { occupancyForCatalogItem, SharedVolumeCatalogInspectService } from './shared-volume-catalog.service.js';

describe('shared catalog occupancy matcher', () => {
  it('emits the six occupancies and skips never-seen nodes', () => {
    expect(occupancyForCatalogItem({
      pgCatalogState: 'absent',
      incusPresent: false,
      hasAttachment: false,
    })).toBe('skip');
    expect(occupancyForCatalogItem({
      pgCatalogState: 'present',
      incusPresent: null,
      hasAttachment: true,
    })).toBe('unreachable');
    expect(occupancyForCatalogItem({
      pgCatalogState: 'present',
      incusPresent: false,
      hasAttachment: true,
    })).toBe('dangling_pg');
    expect(occupancyForCatalogItem({
      pgCatalogState: 'ensuring',
      incusPresent: false,
      hasAttachment: false,
    })).toBe('dangling_pg');
    expect(occupancyForCatalogItem({
      pgCatalogState: 'absent',
      incusPresent: true,
      hasAttachment: false,
    })).toBe('dangling_incus');
    expect(occupancyForCatalogItem({
      pgCatalogState: 'present',
      incusPresent: true,
      hasAttachment: true,
    })).toBe('in_use');
    expect(occupancyForCatalogItem({
      pgCatalogState: 'present',
      incusPresent: true,
      hasAttachment: false,
    })).toBe('cache');
    expect(occupancyForCatalogItem({
      pgCatalogState: 'ensuring',
      incusPresent: true,
      hasAttachment: false,
    })).toBe('ensuring');
  });
});

describe('shared volume live usage', () => {
  const volume = { id: 'v1', incus_name: `nyv-${'a'.repeat(32)}`, size_bytes: '100', shared_backend_id: 'b1' };
  const placement = (serverId: string) => ({
    server_id: serverId,
    pool_name: 'meowfs',
    driver: 'cephfs',
    resize_family: 'quota_online',
    catalog_state: 'present',
    server_status: 'online',
  });

  function service(answers: Record<string, unknown>) {
    const repository = { listPlacementsWithPool: vi.fn(async () => [placement('a'), placement('b')]) };
    const clients = {
      get: vi.fn(async (serverId: string) => ({
        getStorageVolumeState: vi.fn(async () => ({ metadata: { usage: answers[serverId] } })),
      })),
    };
    const database = {} as never;
    const catalog = new SharedVolumeCatalogInspectService(repository as never, database, clients as never);
    // No further executors beyond the placements.
    vi.spyOn(catalog as unknown as { usageCandidates: (v: unknown) => Promise<unknown[]> }, 'usageCandidates')
      .mockResolvedValue([
        { serverId: 'a', poolName: 'meowfs', driver: 'cephfs', resizeFamily: 'quota_online' },
        { serverId: 'b', poolName: 'meowfs', driver: 'cephfs', resizeFamily: 'quota_online' },
      ]);
    return catalog;
  }

  it('keeps asking when an executor answers without a real CephFS usage', async () => {
    const catalog = service({
      a: { used: 100, total: 100 },
      b: { used: 30, total: 100, nyabase_used_source: 'ceph.dir.rbytes' },
    });
    await expect(catalog.observeUsage(volume as never)).resolves.toEqual({ status: 'observed', usedBytes: 30n });
  });

  it('reports unknown only when no executor knows', async () => {
    const catalog = service({ a: { used: 100, total: 100 }, b: { used: 100, total: 100 } });
    await expect(catalog.observeUsage(volume as never)).resolves.toEqual({ status: 'observed', usedBytes: null });
  });
});
