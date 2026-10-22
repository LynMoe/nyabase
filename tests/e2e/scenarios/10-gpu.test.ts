// GPU passthrough on a host that has a GPU (E2E_SERVER_n_GPU_PCI).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  canonicalPciAddress,
  type ContainerDto,
  type GpuDevicesResponseDto,
  type IntentAcceptedDto,
  type ServerGpuDto,
} from '@nyabase/common';
import { ApiError } from '../client/api.js';
import { Harness, type TestUser } from '../client/harness.js';
import { waitIntent } from '../client/poll.js';
import { tryLoadState, type RunServer } from '../client/state.js';

const state = tryLoadState();
const skip = state && !state.servers.some((server) => server.gpuPci)
  ? 'no server has a GPU configured (E2E_SERVER_n_GPU_PCI)'
  : false;

describe('GPU', { skip }, () => {
  let h: Harness;
  let server: RunServer;
  let pci: string;
  let user: TestUser;
  let container: ContainerDto;
  const gpu = () => h.api.get<ServerGpuDto>(`/servers/${server.id}/gpu`);

  before(async () => {
    h = await Harness.start();
    server = h.state.servers.find((entry) => entry.gpuPci)!;
    pci = canonicalPciAddress(server.gpuPci!)!;
    const prior = await gpu();
    await h.api.patch(`/servers/${server.id}/gpu`, { enabled: true });
    if (!prior.enabled) h.defer('restore GPU switch', () => h.api.patch(`/servers/${server.id}/gpu`, { enabled: false }));
    user = await h.newUser('gpu');
    await h.addSshKey(user);
    await h.grantServer(user, server, { gpuPciAddresses: [pci] });
  });
  after(async () => h?.cleanup());

  it('lists the card to administrators and to a user whose grant allows it', async () => {
    const info = await gpu();
    assert.equal(info.enabled, true);
    assert.equal(info.occupiedDeviceCount, 0);
    const all = await h.api.get<GpuDevicesResponseDto>(`/servers/${server.id}/gpus`, { scope: 'all' });
    assert.ok(all.items.some((device) => device.pciAddress === pci), 'the configured card is in the inventory');
    const mine = await user.session.api.get<GpuDevicesResponseDto>(`/servers/${server.id}/gpus`);
    assert.deepEqual(mine.items.map((device) => device.pciAddress), [pci]);
    assert.equal(await user.session.api.status('GET', `/servers/${server.id}/gpus?scope=all`), 403);
  });

  it('refuses a card the grant does not cover', async () => {
    const other = await h.newUser('nogpu');
    await h.grantServer(other, server);
    const status = await other.session.api.status('POST', '/containers', {
      serverId: server.id, imageId: h.state.image.id, name: h.name('nogpu'),
      rootSizeBytes: h.state.rootSizeBytes, memBytes: 1024 ** 3,
      gpuPciAddresses: [pci], powerIntent: 'stopped',
    });
    assert.ok(status === 403 || status === 409, `create without a GPU grant gave ${status}`);
  });

  it('runs a container with the card, claims it exclusively and blocks disabling', async () => {
    container = await h.createContainer(user, server, { gpuPciAddresses: [pci] });
    assert.deepEqual(container.gpu, { nvidiaRuntime: true, pciAddresses: [pci] });
    assert.equal((await gpu()).occupiedDeviceCount, 1);
    assert.match(await h.ssh(user, container, 'nvidia-smi -L'), /GPU/);

    await assert.rejects(
      user.session.api.post('/containers', {
        serverId: server.id, imageId: h.state.image.id, name: h.name('second'),
        rootSizeBytes: h.state.rootSizeBytes, memBytes: 1024 ** 3,
        gpuPciAddresses: [pci], powerIntent: 'stopped',
      }),
      (error: unknown) => error instanceof ApiError && error.status === 409,
    );
    await assert.rejects(
      h.api.patch(`/servers/${server.id}/gpu`, { enabled: false }),
      (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'GPU_OCCUPIED',
    );
  });

  it('releases the card after a stop and a GPU detach', async () => {
    const api = user.session.api;
    await h.power(api, container.id, 'stop');
    await waitIntent(api, await api.patch<IntentAcceptedDto>(`/containers/${container.id}/gpus`, { pciAddresses: [] }));
    const released = await api.get<ContainerDto>(`/containers/${container.id}`);
    assert.deepEqual(released.gpu?.pciAddresses ?? [], []);
    assert.equal((await gpu()).occupiedDeviceCount, 0);
  });
});
