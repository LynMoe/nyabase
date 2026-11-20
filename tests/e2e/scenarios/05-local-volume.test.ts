// Data disks: one volume per user and disk, created and mounted by the
// platform, sized by the grant (forced below the data, never by stopping).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ContainerStatus,
  ResourceLifecyclePhase,
  type ContainerDto,
  type DataDiskGrantChangeDto,
  type LiveServerAccessDto,
  type StorageCapacityDto,
  type StorageMountPreviewDto,
  type VolumeDto,
} from '@nyabase/common';
import { GIB, Harness, type TestUser } from '../client/harness.js';
import { pollUntil } from '../client/poll.js';
import { tryLoadState } from '../client/state.js';

const state = tryLoadState();
const skip = state && !state.servers.some((server) => server.dataPoolId)
  ? 'needs a data pool (E2E_SERVER_<n>_DATA_POOL in lab.env)'
  : false;

const MOUNT = '/data-e2e';
const MIB = 1024 ** 2;

describe('data disk: created, mounted and sized by the platform', { skip }, () => {
  let h: Harness;
  let user: TestUser;
  let container: ContainerDto;
  let grantId: string;
  let volume: VolumeDto;

  const server = () => h.state.servers.find((entry) => entry.dataPoolId)!;
  const myVolume = async () => (await user.session.api.get<VolumeDto[]>('/volumes'))
    .find((entry) => entry.poolId === server().dataPoolId);
  const sizeIs = (bytes: number) => pollUntil(async () => {
    const current = await myVolume();
    return current?.sizeBytes === bytes && current.lifecyclePhase === ResourceLifecyclePhase.Active ? current : undefined;
  }, { what: `the volume to be sized ${bytes}`, timeoutMs: 180_000 });

  before(async () => {
    h = await Harness.start();
    user = await h.newUser('disk');
    await h.addSshKey(user);
    await h.grantServer(user, server());
    grantId = await h.grantDataDisks(user, server(), [server().dataPoolId!], 2 * GIB);
    container = await h.createContainer(user, server());
  });
  after(async () => h?.cleanup());

  it('previews enabling the disk: the user gets a volume mounted in the container', async () => {
    const preview = await h.api.post<StorageMountPreviewDto>(
      `/servers/${server().id}/storage-pools/${server().dataPoolId}/mount-preview`,
      { mountPath: MOUNT },
    );
    assert.ok(preview.volumes.some((entry) => entry.userId === user.id));
    assert.ok(preview.mounts.some((entry) => entry.containerId === container.id));
    assert.equal(await user.session.api.status('POST',
      `/servers/${server().id}/storage-pools/${server().dataPoolId}/mount-preview`, { mountPath: MOUNT }), 403);
  });

  it('creates the volume and mounts it into the running container once the disk is enabled', async () => {
    await h.enableDataDisk(server(), MOUNT);
    volume = await sizeIs(2 * GIB);
    assert.equal(volume.mountPath, MOUNT);
    assert.equal(volume.ownerId, user.id);
    await h.waitMount(user.session.api, container.id, 'volumes', MOUNT);
    const out = await h.ssh(user, container, `mountpoint -q ${MOUNT} && echo on-disk > ${MOUNT}/f && cat ${MOUNT}/f && df -B1 --output=size ${MOUNT} | tail -1`);
    assert.match(out, /on-disk/);
    const size = Number(out.trim().split(/\s+/).at(-1));
    assert.ok(size > 1.9 * GIB && size <= 2 * GIB, `df shows the grant: ${size}`);
    // Users cannot create, resize or delete volumes any more.
    assert.equal(await user.session.api.status('POST', '/volumes', { name: 'x', sizeBytes: GIB }), 404);
    assert.equal(await user.session.api.status('DELETE', `/volumes/${volume.id}`), 403);
  });

  it('shows the grant as a group with the data written', async () => {
    await h.ssh(user, container, `dd if=/dev/urandom of=${MOUNT}/blob bs=1M count=300 status=none && sync`);
    const access = await pollUntil(async () => {
      const servers = await user.session.api.get<{ servers: LiveServerAccessDto[] }>('/me/access');
      const group = servers.servers.find((entry) => entry.serverId === server().id)?.dataDisks?.[0];
      return group && group.usedBytes > 250 * MIB ? group : undefined;
    }, { what: 'the group to report the data', timeoutMs: 120_000 });
    assert.equal(access.grantId, grantId);
    assert.equal(access.limitBytes, 2 * GIB);
    const capacity = await user.session.api.get<StorageCapacityDto>(`/servers/${server().id}/storage-capacity`);
    assert.equal(capacity.pools.find((pool) => pool.poolId === server().dataPoolId)?.grant?.grantId, grantId);
  });

  it('enforces a smaller grant below the data at once: read and delete only, nothing stops', async () => {
    const change = await h.api.patch<DataDiskGrantChangeDto>(`/users/${user.id}/data-disk-grants/${grantId}`, {
      limitBytes: 200 * MIB,
    });
    assert.equal(change.grant?.limitBytes, 200 * MIB);
    await sizeIs(200 * MIB);
    const blocked = await pollUntil(async () => {
      const out = await h.ssh(user, container,
        `dd if=/dev/zero of=${MOUNT}/more bs=1M count=8 status=none 2>&1 && echo wrote || echo refused`);
      return /refused/.test(out) ? out : undefined;
    }, { what: 'writes to be refused', timeoutMs: 120_000, intervalMs: 5_000 });
    assert.match(blocked, /refused/);
    assert.match(await h.ssh(user, container, `cat ${MOUNT}/f`), /on-disk/);
    const live = await user.session.api.get<ContainerDto>(`/containers/${container.id}`);
    assert.equal(live.actual.status, ContainerStatus.Running, 'the container keeps running');

    await h.ssh(user, container, `rm -f ${MOUNT}/blob ${MOUNT}/more && sync`);
    await h.api.patch(`/users/${user.id}/data-disk-grants/${grantId}`, { limitBytes: 2 * GIB });
    await sizeIs(2 * GIB);
    assert.match(await h.ssh(user, container,
      `dd if=/dev/zero of=${MOUNT}/more bs=1M count=8 status=none && echo wrote`), /wrote/);
  });

  it('mounts the volume into a new container at creation', async () => {
    const second = await h.createContainer(user, server());
    const mount = await h.waitMount(user.session.api, second.id, 'volumes', MOUNT);
    assert.equal(mount.volumeId, volume.id);
    assert.match(await h.ssh(user, second, `cat ${MOUNT}/f`), /on-disk/);
  });

  it('leaves the disk out of containers under maintenance and brings it back', async () => {
    const path = `/servers/${server().id}/storage-pools/${server().dataPoolId}`;
    const pool = await h.dataPool(server());
    await h.api.patch(path, { expectedRevision: pool.revision, maintenance: true });
    await pollUntil(async () => {
      const out = await h.ssh(user, container, `mountpoint -q ${MOUNT} && echo mounted || echo gone`);
      return /gone/.test(out) ? true : undefined;
    }, { what: 'the disk to leave the container', timeoutMs: 180_000, intervalMs: 5_000 });
    const parked = await h.dataPool(server());
    await h.api.patch(path, { expectedRevision: parked.revision, maintenance: false });
    await pollUntil(async () => {
      const out = await h.ssh(user, container, `mountpoint -q ${MOUNT} && cat ${MOUNT}/f || echo gone`);
      return /on-disk/.test(out) ? true : undefined;
    }, { what: 'the disk to come back', timeoutMs: 180_000, intervalMs: 5_000 });
  });

  it('unmounts the volume when the grant is revoked, and lets the administrator delete it then', async () => {
    await h.api.delete(`/users/${user.id}/data-disk-grants/${grantId}`);
    await pollUntil(async () => {
      const mounts = await user.session.api.get<unknown[]>(`/containers/${container.id}/volumes`);
      return mounts.length === 0 ? true : undefined;
    }, { what: 'the revoked volume to be unmounted', timeoutMs: 300_000 });
    await h.deleteUserVolumes(user.id);
    assert.equal(await myVolume(), undefined);
  });
});
