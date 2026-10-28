// One shared (CephFS-backed) volume mounted by containers on two servers.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  ResourceLifecyclePhase,
  type ContainerDto,
  type IntentAcceptedDto,
  type SharedBackendDto,
  type SharedVolumeCatalogInspectDto,
  type SharedVolumeDto,
  type VolumeAttachmentDto,
} from '@nyabase/common';
import { ApiError } from '../client/api.js';
import { GIB, Harness, type TestUser } from '../client/harness.js';
import { pollUntil, waitIntent } from '../client/poll.js';
import { tryLoadState } from '../client/state.js';

const state = tryLoadState();
const skip = state && (!state.sharedBackendId || state.servers.filter((s) => s.sharedPoolId).length < 2)
  ? 'needs a shared backend registered on two servers (E2E_SHARED_* in lab.env)'
  : false;

describe('shared volume across two servers', { skip }, () => {
  let h: Harness;
  let user: TestUser;
  let volumeId: string;
  let containers: ContainerDto[];
  const backendId = () => h.state.sharedBackendId!;
  const volume = () => user.session.api.get<SharedVolumeDto>(`/shared-volumes/${volumeId}`);

  before(async () => {
    h = await Harness.start();
    user = await h.newUser('shared');
    await h.addSshKey(user);
    const servers = h.state.servers.filter((server) => server.sharedPoolId).slice(0, 2);
    for (const server of servers) await h.grantServer(user, server);
    await h.api.put(`/users/${user.id}/shared-backend-grants/${backendId()}`, {
      limitBytes: 20 * GIB,
      expiresAt: null,
    });
    h.defer('revoke shared backend grant', () =>
      h.api.delete(`/users/${user.id}/shared-backend-grants/${backendId()}`));
    containers = [];
    for (const server of servers) containers.push(await h.createContainer(user, server));
  });
  after(async () => h?.cleanup());

  it('shows the backend to the administrator with both executors registered', async () => {
    const backends = await h.api.get<SharedBackendDto[]>('/shared-backends', { scope: 'all' });
    const backend = backends.find((entry) => entry.id === backendId());
    assert.ok(backend);
    assert.equal(backend.hasOnlineExecutor, true);
    assert.ok((backend.executors ?? []).filter((executor) => executor.registered).length >= 2);
    const mine = await user.session.api.get<SharedBackendDto[]>('/shared-backends');
    assert.deepEqual(mine.map((entry) => entry.id), [backendId()]);
    assert.equal(mine[0]!.executors, undefined, 'users do not see executors');
  });

  it('creates the volume on the backend within the grant', async () => {
    const api = user.session.api;
    const created = await api.post<SharedVolumeDto>('/shared-volumes', {
      name: h.name('shared'),
      sizeBytes: 2 * GIB,
      scope: { kind: 'shared', sharedBackendId: backendId() },
    });
    volumeId = created.id;
    h.defer('delete shared volume', () => h.deleteVolume(h.api, volumeId, 'shared-volumes'));
    assert.equal(created.sharedBackendId, backendId());
    assert.equal(created.ownerId, user.id);
    assert.equal(created.lifecyclePhase, ResourceLifecyclePhase.Active);
    // Above the 20 GiB backend grant.
    const tooBig = await api.status('POST', '/shared-volumes', {
      name: h.name('toobig'),
      sizeBytes: 64 * GIB,
      scope: { kind: 'shared', sharedBackendId: backendId() },
    });
    assert.ok(tooBig === 403 || tooBig === 409, `over-grant create gave ${tooBig}`);
  });

  it('mounts it in both containers and shares data between servers', async () => {
    const api = user.session.api;
    for (const container of containers) {
      await waitIntent(api, await api.post<IntentAcceptedDto>(`/containers/${container.id}/shared-volumes`, {
        volumeId,
        containerPath: '/mnt/shared',
        readOnly: false,
      }));
    }
    await pollUntil(async () => {
      const attachments = (await volume()).attachments;
      return attachments.length === 2 && attachments.every((a) => a.bindState === 'attached') ? true : undefined;
    }, { what: 'both attachments to bind' });
    assert.notEqual(containers[0]!.serverId, containers[1]!.serverId);

    const marker = randomBytes(8).toString('hex');
    await h.ssh(user, containers[0]!, `echo ${marker} > /mnt/shared/marker && sync`);
    const seen = await pollUntil(async () => {
      const out = await h.ssh(user, containers[1]!, 'cat /mnt/shared/marker 2>/dev/null || true');
      return out.trim() === marker ? out : undefined;
    }, { what: 'the marker to appear on the other server', timeoutMs: 90_000, intervalMs: 3_000 });
    assert.equal(seen.trim(), marker);
  });

  it('keeps file ownership identical across containers with isolated uid maps', async () => {
    const [writer, reader] = containers as [ContainerDto, ContainerDto];
    const owner = (await h.ssh(user, writer, 'id -u; umask 077; echo private > /mnt/shared/owned && stat -c %u /mnt/shared/owned'))
      .trim().split(/\s+/);
    assert.equal(owner[0], owner[1], 'the file belongs to the writing user inside the guest');
    const seen = await pollUntil(async () => {
      const out = (await h.ssh(user, reader, 'id -u; stat -c %u /mnt/shared/owned 2>/dev/null && cat /mnt/shared/owned')).trim();
      return out.endsWith('private') ? out.split(/\s+/) : undefined;
    }, { what: 'the private file to be readable from the other container', timeoutMs: 90_000, intervalMs: 3_000 });
    assert.equal(seen[0], owner[0], 'the reader runs as the same guest uid');
    assert.equal(seen[1], owner[0], 'and sees the same owner, not a shifted host uid');
  });

  it('lets only the owner and administrators see it', async () => {
    const other = await h.newUser('sharedother');
    assert.equal(await other.session.api.status('GET', `/shared-volumes/${volumeId}`), 404);
    assert.equal(await other.session.api.status('DELETE', `/shared-volumes/${volumeId}`), 404);
    assert.equal(await other.session.api.status('GET', `/shared-volumes/${volumeId}/catalogs`), 403);
    const catalogs = await h.api.get<SharedVolumeCatalogInspectDto>(`/shared-volumes/${volumeId}/catalogs`);
    assert.equal(catalogs.volumeId, volumeId);
    assert.ok(catalogs.items.length >= 2);
  });

  it('reports the real usage and shrinks down to it, not below', async () => {
    // Incus answers a CephFS volume's quota as its usage; the agent replaces it
    // with ceph.dir.rbytes, so a shrink above the data goes through.
    const api = user.session.api;
    await h.ssh(user, containers[0]!, 'dd if=/dev/urandom of=/mnt/shared/blob bs=1M count=200 status=none && sync');
    const before = await volume();
    const shrunk = await api.patch<SharedVolumeDto | IntentAcceptedDto>(`/shared-volumes/${volumeId}`, {
      expectedRevision: before.revision,
      sizeBytes: GIB,
    });
    if ('intentId' in shrunk) await waitIntent(api, shrunk);
    const after = await volume();
    assert.equal(after.sizeBytes, GIB);
    assert.ok(after.usedBytes !== null && after.usedBytes >= 190 * 1024 * 1024 && after.usedBytes < 400 * 1024 * 1024,
      `usage is the data, not the quota: ${after.usedBytes}`);
    const host = h.state.servers.find((server) => server.id === containers[0]!.serverId)!;
    const pool = (await h.api.get<SharedBackendDto>(`/shared-backends/${backendId()}`, { scope: 'all' }))
      .executors!.find((executor) => executor.serverId === host.id)!.incusName;
    await pollUntil(async () => {
      const quota = (await h.onHost(host,
        `getfattr --only-values -n ceph.quota.max_bytes /var/lib/incus/storage-pools/${pool}/custom/default_${after.incusName}`)).trim();
      return quota === String(GIB) ? quota : undefined;
    }, { what: 'the CephFS quota to shrink', timeoutMs: 120_000 });
    await assert.rejects(api.patch(`/shared-volumes/${volumeId}`, { expectedRevision: after.revision, sizeBytes: 100 * 1024 * 1024 }),
      (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'VOLUME_SHRINK_BELOW_USAGE');
    await h.ssh(user, containers[0]!, 'rm -f /mnt/shared/blob && sync');
  });

  it('grows the volume, detaches from both containers and deletes it', async () => {
    const api = user.session.api;
    const current = await volume();
    const resized = await api.patch<SharedVolumeDto | IntentAcceptedDto>(`/shared-volumes/${volumeId}`, {
      expectedRevision: current.revision,
      sizeBytes: 3 * GIB,
    });
    if ('intentId' in resized) await waitIntent(api, resized);
    await pollUntil(async () => ((await volume()).sizeBytes === 3 * GIB ? true : undefined),
      { what: 'the shared volume to grow' });

    for (const container of containers) await h.power(api, container.id, 'stop');
    for (const attachment of (await volume()).attachments) {
      await waitIntent(api, await api.delete<IntentAcceptedDto>(
        `/containers/${attachment.containerId}/shared-volumes/${attachment.attachmentId}`,
      ));
    }
    await pollUntil(async () => ((await volume()).attachments.length === 0 ? true : undefined),
      { what: 'the attachments to disappear' });
    const listed = await api.get<VolumeAttachmentDto[]>(`/containers/${containers[0]!.id}/shared-volumes`);
    assert.deepEqual(listed, []);
    await h.deleteVolume(api, volumeId, 'shared-volumes');
  });
});
