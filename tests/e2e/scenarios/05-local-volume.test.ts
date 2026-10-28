// Local volume: create, attach to a running container, resize, detach, delete.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ResourceLifecyclePhase,
  type ContainerDto,
  type IntentAcceptedDto,
  type StorageCapacityDto,
  type VolumeAttachmentDto,
  type VolumeDto,
} from '@nyabase/common';
import { ApiError } from '../client/api.js';
import { GIB, Harness, type TestUser } from '../client/harness.js';
import { pollUntil, waitIntent } from '../client/poll.js';

describe('local volume create, attach, resize and delete', () => {
  let h: Harness;
  let user: TestUser;
  let container: ContainerDto;
  let volumeId: string;

  const volume = () => user.session.api.get<VolumeDto>(`/volumes/${volumeId}`);

  before(async () => {
    h = await Harness.start();
    user = await h.newUser('vol');
    await h.addSshKey(user);
    await h.grantServer(user, h.server);
    await h.grantPool(user, h.server.poolId);
    container = await h.createContainer(user, h.server);
  });
  after(async () => h?.cleanup());

  it('creates a volume inside the granted pool', async () => {
    const api = user.session.api;
    const capacity = await api.get<StorageCapacityDto>(`/servers/${h.server.id}/storage-capacity`);
    assert.ok(capacity.pools.some((pool) => pool.poolId === h.server.poolId));

    const accepted = await api.post<IntentAcceptedDto>('/volumes', {
      name: h.name('data'),
      sizeBytes: 2 * GIB,
      scope: { kind: 'local', serverId: h.server.id, poolId: h.server.poolId },
    });
    volumeId = accepted.resourceId;
    h.defer('delete volume', () => h.deleteVolume(h.api, volumeId));
    await waitIntent(api, accepted);
    const created = await volume();
    assert.equal(created.lifecyclePhase, ResourceLifecyclePhase.Active);
    assert.equal(created.sizeBytes, 2 * GIB);
    assert.equal(created.serverId, h.server.id);
    assert.equal(created.ownerId, user.id);
    assert.deepEqual(created.attachments, []);
    assert.ok((await api.get<VolumeDto[]>('/volumes')).some((entry) => entry.id === volumeId));
    assert.equal(await api.status('GET', '/volumes?scope=all'), 403);
  });

  it('attaches to the running container and the guest sees a mount', async () => {
    const api = user.session.api;
    await waitIntent(api, await api.post<IntentAcceptedDto>(`/containers/${container.id}/volumes`, {
      volumeId,
      containerPath: '/mnt/e2e-data',
      readOnly: false,
    }));
    await pollUntil(async () => {
      const [attachment] = (await volume()).attachments;
      return attachment?.bindState === 'attached' ? attachment : undefined;
    }, { what: 'the attachment to bind' });
    const attachments = await api.get<VolumeAttachmentDto[]>(`/containers/${container.id}/volumes`);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]!.containerPath, '/mnt/e2e-data');
    const out = await h.ssh(user, container,
      'mountpoint -q /mnt/e2e-data && echo data-on-volume > /mnt/e2e-data/f && cat /mnt/e2e-data/f');
    assert.match(out, /data-on-volume/);
  });

  it('refuses to delete an attached volume or detach from a running container', async () => {
    const api = user.session.api;
    await assert.rejects(api.delete(`/volumes/${volumeId}`),
      (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'VOLUME_REQUIRES_UNBIND');
    const [attachment] = (await volume()).attachments;
    await assert.rejects(api.delete(`/containers/${container.id}/volumes/${attachment!.attachmentId}`),
      (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'VOLUME_DETACH_REQUIRES_STOP');
  });

  it('renames and grows the volume, and shrinks it again where the pool allows', async () => {
    const api = user.session.api;
    const renamed = await api.patch<VolumeDto>(`/volumes/${volumeId}`, {
      expectedRevision: (await volume()).revision,
      name: h.name('renamed'),
    });
    assert.notEqual(renamed.name, '');

    const grown = await volume();
    await waitIntent(api, await api.patch<IntentAcceptedDto>(`/volumes/${volumeId}`, {
      expectedRevision: grown.revision,
      sizeBytes: 3 * GIB,
    }));
    assert.equal((await volume()).sizeBytes, 3 * GIB);
    assert.equal(await api.status('PATCH', `/volumes/${volumeId}`, {
      expectedRevision: 1,
      sizeBytes: 4 * GIB,
    }), 409, 'a stale revision is a conflict');

    const current = await volume();
    if (current.capability.shrinkOnline) {
      await waitIntent(api, await api.patch<IntentAcceptedDto>(`/volumes/${volumeId}`, {
        expectedRevision: current.revision,
        sizeBytes: 2 * GIB,
      }));
      assert.equal((await volume()).sizeBytes, 2 * GIB);
    }
  });

  it('resizes the root disk and hot-attaches a second volume while the first is attached', async () => {
    // Incus (7.4-7.5.1) fails every limit recompute of a running instance that
    // holds a throttled custom volume (`Invalid block device "tmpfs"`), so only
    // the root disk carries limits.read/write.
    const api = user.session.api;
    const current = await api.get<ContainerDto>(`/containers/${container.id}`);
    await waitIntent(api, await api.patch<IntentAcceptedDto>(`/containers/${container.id}/root-size`, {
      sizeBytes: current.rootSizeBytes + GIB,
    }));
    assert.equal((await api.get<ContainerDto>(`/containers/${container.id}`)).rootSizeBytes, current.rootSizeBytes + GIB);

    const accepted = await api.post<IntentAcceptedDto>('/volumes', {
      name: h.name('second'),
      sizeBytes: GIB,
      scope: { kind: 'local', serverId: h.server.id, poolId: h.server.poolId },
    });
    const secondId = accepted.resourceId;
    h.defer('delete the second volume', () => h.deleteVolume(h.api, secondId));
    await waitIntent(api, accepted);
    await waitIntent(api, await api.post<IntentAcceptedDto>(`/containers/${container.id}/volumes`, {
      volumeId: secondId,
      containerPath: '/mnt/e2e-second',
      readOnly: false,
    }));
    const withBoth = await h.waitContainer(api, container.id,
      (c) => c.volumes.length === 2 && c.volumes.every((v) => v.bindState === 'attached'), 'both volumes attached');
    const instance = withBoth.instanceName!;
    const devices = JSON.parse(await h.incus(h.server, ['query', `/1.0/instances/${instance}`])) as {
      devices: Record<string, Record<string, string>>;
    };
    for (const [name, device] of Object.entries(devices.devices)) {
      if (device.type !== 'disk') continue;
      if (name === 'root') assert.ok(device['limits.read'] && device['limits.write'], 'the root disk is throttled');
      else assert.equal(device['limits.read'] ?? device['limits.write'], undefined, `${name} carries no limits`);
    }

    // A stop and start with two volumes attached (the start used to fail on the second).
    await h.power(api, container.id, 'stop');
    await h.power(api, container.id, 'start', user);
    const out = await h.ssh(user, container, 'mountpoint -q /mnt/e2e-data && mountpoint -q /mnt/e2e-second && cat /mnt/e2e-data/f');
    assert.match(out, /data-on-volume/);

    await h.power(api, container.id, 'stop');
    const second = (await api.get<ContainerDto>(`/containers/${container.id}`)).volumes.find((v) => v.volumeId === secondId)!;
    await waitIntent(api, await api.delete<IntentAcceptedDto>(`/containers/${container.id}/volumes/${second.id}`));
    await h.waitContainer(api, container.id, (c) => c.volumes.length === 1, 'the second volume to detach');
    await h.deleteVolume(api, secondId);
    await h.power(api, container.id, 'start', user);
  });

  it('detaches after a stop and then deletes the volume', async () => {
    const api = user.session.api;
    await h.power(api, container.id, 'stop');
    const [attachment] = (await volume()).attachments;
    await waitIntent(api, await api.delete<IntentAcceptedDto>(
      `/containers/${container.id}/volumes/${attachment!.attachmentId}`,
    ));
    await pollUntil(async () => ((await volume()).attachments.length === 0 ? true : undefined),
      { what: 'the attachment to disappear' });
    await h.deleteVolume(api, volumeId);
    assert.equal(await api.status('GET', `/volumes/${volumeId}`), 404);
  });
});
