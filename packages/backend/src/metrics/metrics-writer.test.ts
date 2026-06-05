import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { MetricsWriter } from './metrics-writer.js';
import type { UsersService } from '../users/users.service.js';
import type { RuntimeContainerEntity } from '../entities/runtime-container.entity.js';
import type { ContainerEntity } from '../entities/container.entity.js';

describe('MetricsWriter identity labels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('normalizes numeric user ids and fills missing user ids from runtime/container ownership', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: vi.fn() });
    vi.stubGlobal('fetch', fetchMock);
    const writer = new MetricsWriter(
      { get: vi.fn().mockReturnValue('http://victoria-metrics') } as unknown as ConfigService,
      {
        getUserIdsByNumericIds: vi.fn().mockResolvedValue(new Map([[1001, 'user-a']])),
      } as unknown as UsersService,
      {
        find: vi.fn().mockResolvedValue([
          {
            runtimeId: 'runtime-a-full-id',
            containerId: 'container-a',
            ownerId: null,
          },
        ]),
      } as unknown as Repository<RuntimeContainerEntity>,
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
});
