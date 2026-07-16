import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import { MetricsWriter } from './metrics-writer.js';
import type { UsersService } from '../users/users.service.js';
import type { ContainerEntity } from '../entities/container.entity.js';
import type { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { MAX_METRIC_POINTS_PER_BATCH } from '@nyabase/common';

function makeWriter(fetchMock: ReturnType<typeof vi.fn>): MetricsWriter {
  vi.stubGlobal('fetch', fetchMock);
  return new MetricsWriter(
    { get: vi.fn().mockReturnValue('http://victoria-metrics') } as unknown as NyabaseConfigService,
    { getUserIdsByNumericIds: vi.fn().mockResolvedValue(new Map()) } as unknown as UsersService,
    { findBy: vi.fn().mockResolvedValue([]) } as unknown as Repository<ContainerEntity>,
  );
}

describe('MetricsWriter identity labels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('normalizes numeric user ids and fills missing user ids from runtime/container ownership', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: vi.fn() });
    vi.stubGlobal('fetch', fetchMock);
    const writer = new MetricsWriter(
      { get: vi.fn().mockReturnValue('http://victoria-metrics') } as unknown as NyabaseConfigService,
      {
        getUserIdsByNumericIds: vi.fn().mockResolvedValue(new Map([[1001, 'user-a']])),
      } as unknown as UsersService,
      {
        findBy: vi.fn().mockResolvedValue([
          { id: 'container-a', ownerId: 'user-a' },
        ]),
      } as unknown as Repository<ContainerEntity>,
    );

    await writer.writeBatch('srv-1', [
      {
        name: 'nyabase_user_disk_used_bytes',
        labels: { server: 'srv-1', user_id: '1001' },
        value: 123,
        ts: 1,
      },
      {
        name: 'nyabase_container_mem_used_bytes',
        labels: { server: 'srv-1', container_id: 'runtime-a', container_name: 'container-a' },
        value: 456,
        ts: 1,
      },
    ]);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await writer.onModuleDestroy();

    const body = fetchMock.mock.calls[0][1].body as string;
    expect(body).toContain('nyabase_user_disk_used_bytes{server="srv-1",user_id="user-a"} 123 1');
    expect(body).toContain(
      'nyabase_container_mem_used_bytes{server="srv-1",container_id="runtime-a",container_name="container-a",user_id="user-a"} 456 1',
    );
  });

  it('bounds queued points even when the metrics sink cannot flush', async () => {
    const writer = makeWriter(vi.fn().mockResolvedValue({ ok: true, text: vi.fn() }));
    (writer as unknown as { maxConcurrentFlushes: number }).maxConcurrentFlushes = 0;
    const point = { name: 'bounded_metric', labels: {}, value: 1, ts: 1 };

    for (let index = 0; index < 5; index += 1) {
      await writer.writeBatch(
        'srv-1',
        Array.from({ length: MAX_METRIC_POINTS_PER_BATCH }, () => point),
      );
    }

    expect(writer.getStats()).toMatchObject({
      queued: 4,
      queuedPoints: MAX_METRIC_POINTS_PER_BATCH * 4,
      dropped: 1,
      inFlight: 0,
    });
    (writer as unknown as { maxConcurrentFlushes: number }).maxConcurrentFlushes = 1;
    await writer.onModuleDestroy();
  });

  it('rejects an over-limit direct batch before identity lookups', async () => {
    const writer = makeWriter(vi.fn().mockResolvedValue({ ok: true, text: vi.fn() }));
    const point = { name: 'bounded_metric', labels: {}, value: 1, ts: 1 };

    await writer.writeBatch(
      'srv-1',
      Array.from({ length: MAX_METRIC_POINTS_PER_BATCH + 1 }, () => point),
    );

    expect(writer.getStats()).toMatchObject({ queued: 0, queuedPoints: 0, dropped: 1 });
    await writer.onModuleDestroy();
  });

  it('escapes label values before writing Prometheus text', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: vi.fn() });
    const writer = makeWriter(fetchMock);
    await writer.writeBatch('srv-1', [{
      name: 'safe_metric',
      labels: { source: 'quote"\\line\nnext' },
      value: 1,
      ts: 1,
    }]);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = fetchMock.mock.calls[0][1].body as string;
    expect(body).toContain('source="quote\\"\\\\line\\nnext"');
    expect(body.split('\n')).toHaveLength(1);
    await writer.onModuleDestroy();
  });
});
