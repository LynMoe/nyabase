import { describe, expect, it } from 'vitest';
import { observeGpus, seedBackend, seedBackendPool, seedPool, seedServer } from '../iam/access.pg-test-helper.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { GrantServerProfileService, liveHardwareFromResources } from './grant-server-profile.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

const RESOURCES = {
  cpu: { total: 4, sockets: [{ name: ' Intel Xeon 8358 ' }, { name: 'Intel Xeon 8358' }, {}] },
  memory: { total: 274_877_906_944, used: 1 },
  gpu: {
    cards: [
      { pci_address: '0000:4f:00.0', nvidia: { model: 'NVIDIA A800 80GB' } },
      { pci_address: '0000:52:00.0', product: 'GA100', nvidia: {} },
      { pci_address: '0000:03:00.0', product: 'ASPEED' },
    ],
  },
};

describe('liveHardwareFromResources', () => {
  it('counts sockets per model, reads memory and the NVIDIA cards only', () => {
    expect(liveHardwareFromResources(RESOURCES)).toEqual({
      cpuModels: [{ name: 'Intel Xeon 8358', sockets: 2 }, { name: 'CPU', sockets: 1 }],
      memoryBytes: 274_877_906_944,
      gpus: [
        { pciAddress: '00000000:4f:00.0', model: 'NVIDIA A800 80GB' },
        { pciAddress: '00000000:52:00.0', model: 'GA100' },
      ],
    });
  });

  it('tolerates a missing or malformed document', () => {
    expect(liveHardwareFromResources(null)).toEqual({ cpuModels: [], memoryBytes: null, gpus: [] });
    expect(liveHardwareFromResources({ cpu: { sockets: 'x' }, memory: { total: -1 } }))
      .toEqual({ cpuModels: [], memoryBytes: null, gpus: [] });
  });
});

describePg('GrantServerProfileService', () => {
  const topology = [0, 1, 2, 3].map((id) => ({ id, core: id, socket: 0, numa: 0 }));

  it('combines the live hardware with the stored topology, reserved CPUs and local pools', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await seedServer(database);
      const systemPool = await seedPool(database, serverId);
      const dataPool = await seedPool(database, serverId);
      await seedBackendPool(database, serverId, await seedBackend(database));
      await database.updateTable('infra.servers')
        .set({ cpu_topology: JSON.stringify(topology), reserved_cpus: [0], system_pool_id: systemPool, gpu_enabled: true })
        .where('id', '=', serverId)
        .execute();
      const clients = { get: async () => ({ getResources: async () => ({ metadata: RESOURCES }) }) };
      const profile = await new GrantServerProfileService(database, clients as never).profile(serverId);

      expect(profile).toMatchObject({
        serverId,
        live: true,
        cpu: { models: [{ name: 'Intel Xeon 8358', sockets: 2 }, { name: 'CPU', sockets: 1 }], logical: 4, reserved: 1, allocatable: 3 },
        memoryBytes: 274_877_906_944,
        gpu: { enabled: true, cards: [{ model: 'NVIDIA A800 80GB' }, { model: 'GA100' }] },
      });
      // The CephFS pool is a shared backend's, not a data disk of this server.
      expect(profile.pools.map((pool) => [pool.poolId, pool.system]).sort())
        .toEqual([[systemPool, true], [dataPool, false]].sort());
      expect(profile.pools[0]).toMatchObject({ driver: 'dir', totalBytes: 1000, usedBytes: 0 });
    });
  });

  it('falls back to what the database keeps while the server is unreachable', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await seedServer(database);
      await observeGpus(database, serverId, ['00000000:01:00.0']);
      const clients = { get: async () => { throw new Error('The Incus server is unreachable'); } };
      const profile = await new GrantServerProfileService(database, clients as never).profile(serverId);

      expect(profile).toEqual({
        serverId,
        live: false,
        cpu: { models: [], logical: null, reserved: 0, allocatable: null },
        memoryBytes: null,
        pools: [],
        gpu: { enabled: false, cards: [{ pciAddress: '00000000:01:00.0', model: null }] },
      });
      await expect(new GrantServerProfileService(database, clients as never).profile(crypto.randomUUID()))
        .rejects.toMatchObject({ status: 404 });
    });
  });
});
