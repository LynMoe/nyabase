import { describe, expect, it } from 'vitest';
import { CORE_NODE_METRIC_CATALOG, validateNodeMetricSample } from '@nyabase/common';
import { ContainerStateMetricsPublisher, containerStateSamples, managedContainerId } from './container-state-metrics.service.js';

const containerId = '11111111-1111-4111-8111-111111111111';
const volumeId = '33333333-3333-4333-8333-333333333333';
const attachmentHex = '44444444444444444444444444444444';

describe('container state samples', () => {
  it('hyphenates the instance id and resolves volume ids before validation', () => {
    const id = managedContainerId({
      config: {
        'user.nyabase.managed': 'true',
        'user.nyabase.container_id': '11111111111141118111111111111111',
      },
    });
    expect(id).toBe(containerId);
    const samples = containerStateSamples({
      state: {
        disk: {
          root: { usage: 10, total: 40 },
          [`nyd-${attachmentHex}`]: { usage: 3, total: 8 },
        },
        network: {
          eth0: { counters: { bytes_received: 100, bytes_sent: 50 } },
          lo: { counters: { bytes_received: 1, bytes_sent: 1 } },
        },
      },
    }, containerId, {
      rootSizeBytes: 40,
      deleting: false,
      volumesByDevice: new Map([[`nyd-${attachmentHex}`, volumeId]]),
    });
    for (const sample of samples) validateNodeMetricSample(sample, CORE_NODE_METRIC_CATALOG);
    expect(samples).toEqual(expect.arrayContaining([
      { name: 'nyabase_container_root_used_bytes', labels: { container_id: containerId }, value: 10 },
      { name: 'nyabase_container_net_rx_bytes_total', labels: { container_id: containerId, device: 'eth0' }, value: 100 },
      { name: 'nyabase_container_volume_used_bytes', labels: { container_id: containerId, volume_id: volumeId }, value: 3 },
    ]));
    expect(samples.some((sample) => sample.labels.device === 'lo')).toBe(false);
    expect(samples.some((sample) => sample.labels.volume_id === attachmentHex)).toBe(false);
  });

  it('uses the control-plane root size when Incus reports a zero total', () => {
    const samples = containerStateSamples({
      state: { disk: { root: { usage: 4, total: 0 } } },
    }, containerId, { rootSizeBytes: 99, deleting: false, volumesByDevice: new Map() });
    expect(samples).toContainEqual({
      name: 'nyabase_container_root_size_bytes',
      labels: { container_id: containerId },
      value: 99,
    });
  });

  it('omits a missing volume but still emits root and eth0', () => {
    const samples = containerStateSamples({
      state: {
        disk: { root: { usage: 4 }, 'nyd-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': { usage: 1 } },
        network: { eth0: { counters: { bytes_received: 2, bytes_sent: 3 } } },
      },
    }, containerId, { rootSizeBytes: null, deleting: false, volumesByDevice: new Map() });
    expect(samples.map((sample) => sample.name).sort()).toEqual([
      'nyabase_container_net_rx_bytes_total',
      'nyabase_container_net_tx_bytes_total',
      'nyabase_container_root_used_bytes',
    ]);
  });

  it('does not wait for a hung server before writing the other', async () => {
    const writes: string[] = [];
    let releaseSlow: (() => void) | undefined;
    const slowStarted = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const clients = {
      get: async (serverId: string) => ({
        listInstances: async (_recursion: number, options: { signal?: AbortSignal }) => {
          if (serverId === 'slow') {
            releaseSlow?.();
            await new Promise((_resolve, reject) => {
              options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            });
          }
          return {
            metadata: [{
              config: {
                'user.nyabase.managed': 'true',
                'user.nyabase.container_id': '11111111111141118111111111111111',
              },
              state: { disk: { root: { usage: 7, total: 9 } } },
            }],
          };
        },
      }),
    };
    const database = {
      selectFrom: (table: string) => ({
        select: () => database.selectFrom(table),
        where: () => database.selectFrom(table),
        execute: async () => {
          if (table === 'infra.servers') return [{ id: 'fast' }, { id: 'slow' }];
          if (table === 'control.containers') return [];
          return [];
        },
      }),
    };
    const publisher = new ContainerStateMetricsPublisher(
      database as never,
      clients as never,
      { writeBatch: async (serverId: string) => { writes.push(serverId); } } as never,
      { runsWorker: () => false } as never,
      { get: () => true } as never,
    );
    const done = publisher.publishAvailableServers();
    await slowStarted;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(writes).toEqual(['fast']);
    await done;
    expect(writes).toEqual(['fast']);
  }, 10_000);
});
