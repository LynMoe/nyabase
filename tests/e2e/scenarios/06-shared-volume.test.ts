// One shared (CephFS-backed) volume per user, created and mounted by the
// platform into their containers on every server that reaches the backend.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  ResourceLifecyclePhase,
  type ContainerDto,
  type SharedBackendDto,
  type SharedVolumeCatalogInspectDto,
  type SharedVolumeDto,
} from '@nyabase/common';
import { GIB, Harness, type TestUser } from '../client/harness.js';
import { pollUntil } from '../client/poll.js';
import { tryLoadState } from '../client/state.js';

const state = tryLoadState();
const skip = state && (!state.sharedBackendId || state.servers.filter((s) => s.sharedPoolId).length < 2)
  ? 'needs a shared backend registered on two servers (E2E_SHARED_* in lab.env)'
  : false;

const MOUNT = '/shared-e2e';
const MIB = 1024 ** 2;

describe('shared volume across two servers', { skip }, () => {
  let h: Harness;
  let user: TestUser;
  let volume: SharedVolumeDto;
  let containers: ContainerDto[];
  let parked: ContainerDto;
  const backendId = () => h.state.sharedBackendId!;
  const mine = async () => (await user.session.api.get<SharedVolumeDto[]>('/shared-volumes'))
    .find((entry) => entry.sharedBackendId === backendId());
  const sizeIs = (bytes: number) => pollUntil(async () => {
    const current = await mine();
    return current?.sizeBytes === bytes ? current : undefined;
  }, { what: `the shared volume to be sized ${bytes}`, timeoutMs: 180_000 });

  before(async () => {
    h = await Harness.start();
    user = await h.newUser('shared');
    await h.addSshKey(user);
    const servers = h.state.servers.filter((server) => server.sharedPoolId).slice(0, 2);
    for (const server of servers) await h.grantServer(user, server);
    await h.grantBackend(user, GIB);
    containers = [];
    for (const server of servers) containers.push(await h.createContainer(user, server));
    // This container already keeps files where the volume will mount.
    parked = await h.createContainer(user, servers[0]!);
    await h.ssh(user, parked, `mkdir -p ${MOUNT} && echo mine > ${MOUNT}/keep`);
  });
  after(async () => h?.cleanup());

  it('shows the backend to the administrator with both executors registered', async () => {
    const backends = await h.api.get<SharedBackendDto[]>('/shared-backends', { scope: 'all' });
    const backend = backends.find((entry) => entry.id === backendId());
    assert.ok(backend);
    assert.equal(backend.hasOnlineExecutor, true);
    assert.ok((backend.executors ?? []).filter((executor) => executor.registered).length >= 2);
    const visible = await user.session.api.get<SharedBackendDto[]>('/shared-backends');
    assert.deepEqual(visible.map((entry) => entry.id), [backendId()]);
    assert.equal(visible[0]!.executors, undefined, 'users do not see executors');
  });

  it('creates the volume at the grant\'s size once the backend is enabled, and mounts it on both servers', async () => {
    await h.enableSharedBackend(MOUNT);
    volume = await pollUntil(async () => {
      const current = await mine();
      return current?.lifecyclePhase === ResourceLifecyclePhase.Active ? current : undefined;
    }, { what: 'the shared volume to exist' });
    assert.equal(volume.sizeBytes, GIB);
    assert.equal(volume.mountPath, MOUNT);
    for (const container of containers) await h.waitMount(user.session.api, container.id, 'shared-volumes', MOUNT);
    assert.notEqual(containers[0]!.serverId, containers[1]!.serverId);

    const marker = randomBytes(8).toString('hex');
    await h.ssh(user, containers[0]!, `echo ${marker} > ${MOUNT}/marker && sync`);
    const seen = await pollUntil(async () => {
      const out = await h.ssh(user, containers[1]!, `cat ${MOUNT}/marker 2>/dev/null || true`);
      return out.trim() === marker ? out : undefined;
    }, { what: 'the marker to appear on the other server', timeoutMs: 90_000, intervalMs: 3_000 });
    assert.equal(seen.trim(), marker);
  });

  it('does not mount over files already at the path, and mounts once they are moved away', async () => {
    await h.waitMount(user.session.api, parked.id, 'shared-volumes', MOUNT, 'blocked');
    assert.match(await h.ssh(user, parked, `cat ${MOUNT}/keep`), /mine/);
    await h.ssh(user, parked, `mv ${MOUNT} /root/kept-from-mount`);
    await h.power(user.session.api, parked.id, 'restart', user);
    await h.waitMount(user.session.api, parked.id, 'shared-volumes', MOUNT);
    assert.match(await h.ssh(user, parked, `mountpoint -q ${MOUNT} && echo mounted; cat /root/kept-from-mount/keep`),
      /mounted[\s\S]*mine/);
  });

  it('keeps file ownership identical across containers with isolated uid maps', async () => {
    const [writer, reader] = containers as [ContainerDto, ContainerDto];
    const owner = (await h.ssh(user, writer, `id -u; umask 077; echo private > ${MOUNT}/owned && stat -c %u ${MOUNT}/owned`))
      .trim().split(/\s+/);
    assert.equal(owner[0], owner[1], 'the file belongs to the writing user inside the guest');
    const seen = await pollUntil(async () => {
      const out = (await h.ssh(user, reader, `id -u; stat -c %u ${MOUNT}/owned 2>/dev/null && cat ${MOUNT}/owned`)).trim();
      return out.endsWith('private') ? out.split(/\s+/) : undefined;
    }, { what: 'the private file to be readable from the other container', timeoutMs: 90_000, intervalMs: 3_000 });
    assert.equal(seen[0], owner[0], 'the reader runs as the same guest uid');
    assert.equal(seen[1], owner[0], 'and sees the same owner, not a shifted host uid');
  });

  it('lets only the owner and administrators see it', async () => {
    const other = await h.newUser('sharedother');
    assert.equal(await other.session.api.status('GET', `/shared-volumes/${volume.id}`), 404);
    assert.equal(await other.session.api.status('DELETE', `/shared-volumes/${volume.id}`), 403);
    assert.equal(await other.session.api.status('GET', `/shared-volumes/${volume.id}/catalogs`), 403);
    const catalogs = await h.api.get<SharedVolumeCatalogInspectDto>(`/shared-volumes/${volume.id}/catalogs`);
    assert.equal(catalogs.volumeId, volume.id);
    assert.ok(catalogs.items.length >= 2);
  });

  it('enforces a smaller grant below the data at once, and a larger one again', async () => {
    await h.ssh(user, containers[0]!, `dd if=/dev/urandom of=${MOUNT}/blob bs=1M count=200 status=none && sync`);
    await h.api.put(`/users/${user.id}/shared-backend-grants/${backendId()}`, { limitBytes: 100 * MIB, expiresAt: null });
    const shrunk = await sizeIs(100 * MIB);
    const host = h.state.servers.find((server) => server.id === containers[0]!.serverId)!;
    const pool = (await h.api.get<SharedBackendDto>(`/shared-backends/${backendId()}`, { scope: 'all' }))
      .executors!.find((executor) => executor.serverId === host.id)!.incusName;
    await pollUntil(async () => {
      const quota = (await h.onHost(host,
        `getfattr --only-values -n ceph.quota.max_bytes /var/lib/incus/storage-pools/${pool}/custom/default_${shrunk.incusName}`)).trim();
      return quota === String(100 * MIB) ? quota : undefined;
    }, { what: 'the CephFS quota to drop below the data', timeoutMs: 120_000 });
    await pollUntil(async () => {
      const out = await h.ssh(user, containers[1]!,
        `dd if=/dev/zero of=${MOUNT}/more bs=1M count=8 conv=fsync status=none 2>&1 && echo wrote || echo refused`);
      return /refused/.test(out) ? true : undefined;
    }, { what: 'writes to be refused', timeoutMs: 120_000, intervalMs: 5_000 });

    await h.ssh(user, containers[0]!, `rm -f ${MOUNT}/blob ${MOUNT}/more && sync`);
    await h.api.put(`/users/${user.id}/shared-backend-grants/${backendId()}`, { limitBytes: 2 * GIB, expiresAt: null });
    await sizeIs(2 * GIB);
    await pollUntil(async () => {
      const out = await h.ssh(user, containers[1]!,
        `dd if=/dev/zero of=${MOUNT}/more bs=1M count=8 conv=fsync status=none 2>&1 && echo wrote || echo refused`);
      return /wrote/.test(out) ? true : undefined;
    }, { what: 'writes to work again', timeoutMs: 120_000, intervalMs: 5_000 });
  });
});
