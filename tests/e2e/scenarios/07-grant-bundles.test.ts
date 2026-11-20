// A bundle is a set of server quotas and data disks bound to one server; a
// user holds at most one per server, may override any field of it (the
// data-disk list as a whole), and follows every field it does not override.
// No container is created; the compute caps and the disk total are enforced
// at admission, before anything reaches Incus.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  canonicalPciAddress,
  FailureCode,
  type EffectiveAccessDto,
  type GrantBundleDto,
  type GrantBundlePreviewDto,
  type LiveServerAccessDto,
  type PutServerGrantRequest,
  type ServerGpuDto,
  type ServerGrantDto,
} from '@nyabase/common';
import { ApiError, login } from '../client/api.js';
import { psql, uuid } from '../client/db.js';
import { GIB, Harness, type TestUser } from '../client/harness.js';
import type { RunServer } from '../client/state.js';

const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

describe('grant bundles', () => {
  let h: Harness;
  let user: TestUser;
  let server: RunServer;
  let bundle: GrantBundleDto;

  const effective = async (): Promise<LiveServerAccessDto | undefined> => {
    const viaAdmin = await h.api.get<EffectiveAccessDto>(`/users/${user.id}/effective-access`);
    const fresh = await login(h.state.baseUrl, user.username, user.password);
    const viaSelf = await fresh.api.get<EffectiveAccessDto>('/me/access');
    assert.deepEqual(viaSelf.servers, viaAdmin.servers, 'the user sees what the administrator sees');
    const entry = viaAdmin.servers.find((item) => item.serverId === server.id);
    assert.notEqual(entry?.accessPhase, 'grace', 'a grace entry carries no quotas');
    return entry as LiveServerAccessDto | undefined;
  };
  const assign = (body: PutServerGrantRequest) =>
    h.api.put<ServerGrantDto>(`/users/${user.id}/server-grants/${server.id}`, body);

  before(async () => {
    h = await Harness.start();
    server = h.server;
    user = await h.newUser('bundles');
  });
  after(async () => h?.cleanup());

  it('starts without access', async () => {
    assert.equal(await effective(), undefined);
  });

  it('serves the bundle, with an override in place of the bundle\'s value', async () => {
    bundle = await h.newBundle(server, { cpuCores: 1, memBytes: GIB, rootDiskBytes: 10 * GIB });
    const grant = await assign({ bundleId: bundle.id, overrides: { rootDiskBytes: 30 * GIB }, expiresAt: inDays(30) });
    h.defer('delete the grant', () => h.api.delete(`/users/${user.id}/server-grants/${server.id}`));
    assert.deepEqual(grant.overrides, { rootDiskBytes: 30 * GIB });
    const access = (await effective())!;
    assert.equal(access.cpuCores, 1);
    assert.equal(access.memBytes, GIB);
    assert.equal(access.rootDiskBytes, 30 * GIB);
    assert.equal(access.diskBytes, 256 * GIB, 'the disk total the harness bundle gives');
    assert.equal(access.rootDiskAvailableBytes, 30 * GIB, 'a new system disk may take what the ceiling leaves');
    assert.equal(access.gpuCount, 0);
    assert.ok(Math.abs(Date.parse(access.expiresAt!) - Date.parse(inDays(30))) < 120_000);
    assert.ok(access.allowedImageIds.includes(h.state.image.id));

    // The bundle's memory is what admission enforces.
    const denied = await (await login(h.state.baseUrl, user.username, user.password)).api.post('/containers', {
      serverId: server.id, imageId: h.state.image.id, name: h.name('cap'),
      rootSizeBytes: h.state.rootSizeBytes, memBytes: GIB + 1, powerIntent: 'running',
    }).then(() => undefined, (error: unknown) => error);
    assert.ok(denied instanceof ApiError);
    assert.equal(denied.status, 403);
    assert.equal(denied.code, 'MEMORY_GRANT_EXCEEDED');
  });

  it('previews a bundle edit, then applies it to the fields the grant follows only', async () => {
    const preview = await h.api.post<GrantBundlePreviewDto>(`/admin/grant-bundles/${bundle.id}/preview`, {
      cpuCores: 2, rootDiskBytes: 20 * GIB,
    });
    const entry = preview.entries.find((item) => item.userId === user.id);
    assert.deepEqual(entry?.changes, [{ field: 'cpuCores', before: 1, after: 2 }]);
    assert.deepEqual(entry?.overridden, [{ field: 'rootDiskBytes', value: 30 * GIB }]);
    assert.equal((await effective())!.cpuCores, 1, 'a preview changes nothing');

    assert.equal(await h.api.status('PATCH', `/admin/grant-bundles/${bundle.id}`, {
      expectedRevision: bundle.revision + 1, cpuCores: 2,
    }), 409, 'a stale revision is refused');
    bundle = await h.api.patch<GrantBundleDto>(`/admin/grant-bundles/${bundle.id}`, {
      expectedRevision: bundle.revision, cpuCores: 2, rootDiskBytes: 20 * GIB,
    });
    const access = (await effective())!;
    assert.equal(access.cpuCores, 2, 'followed at once');
    assert.equal(access.rootDiskBytes, 30 * GIB, 'the override is kept');
  });

  it('lists data disks in the bundle: followers get them at once, each under its own ceiling', async () => {
    bundle = await h.patchBundle(bundle, { dataDisks: [{ poolId: server.poolId, capBytes: 5 * GIB }] });
    assert.deepEqual(bundle.dataDisks, [{ poolId: server.poolId, capBytes: 5 * GIB }]);
    const access = (await effective())!;
    assert.deepEqual(access.dataDisks.map((disk) => [disk.poolId, disk.capBytes]), [[server.poolId, 5 * GIB]]);
    const foreign = h.state.servers.find((entry) => entry.id !== server.id);
    if (foreign) {
      assert.equal(await h.api.status('PATCH', `/admin/grant-bundles/${bundle.id}`, {
        expectedRevision: bundle.revision, dataDisks: [{ poolId: foreign.poolId, capBytes: null }],
      }), 404, 'a bundle lists only pools of its own server');
    }
  });

  it('asks before replacing the bundle on a server, takes the new bundle\'s disks, and never lapses one both list', async () => {
    const larger = await h.newBundle(server, {
      cpuCores: null, memBytes: 2 * GIB, diskBytes: 300 * GIB, rootDiskBytes: 40 * GIB,
      dataDisks: [{ poolId: server.poolId, capBytes: null }],
    });
    const refused = await assign({ bundleId: larger.id }).then(() => undefined, (error: unknown) => error);
    assert.ok(refused instanceof ApiError);
    assert.equal(refused.status, 409);
    assert.equal(refused.code, FailureCode.ServerGrantExists);

    const replaced = await assign({ bundleId: larger.id, replace: true });
    assert.equal(replaced.bundleId, larger.id);
    assert.deepEqual(replaced.overrides, {}, 'a replacement takes its overrides from the request');
    assert.equal(replaced.expiresAt, null, 'and its expiry: none given is permanent');
    assert.equal(psql(h.state.databaseUrl, `
      SELECT 1 FROM control.access_lapses WHERE user_id = '${uuid(user.id)}'
    `).length, 0, 'coverage never lapsed');
    assert.deepEqual(replaced.dataDisks, [{ poolId: server.poolId, capBytes: null }]);
    const access = (await effective())!;
    assert.equal(access.cpuCores, null, 'null CPU is unlimited');
    assert.equal(access.memBytes, 2 * GIB);
    assert.equal(access.diskBytes, 300 * GIB);
    assert.deepEqual(access.dataDisks.map((disk) => [disk.poolId, disk.capBytes]), [[server.poolId, null]]);

    assert.equal(await h.api.status('DELETE', `/admin/grant-bundles/${larger.id}`), 409, 'a bundle in use stays');
    const zero = { serverId: server.id, cpuCores: null, memBytes: 0, diskBytes: GIB, rootDiskBytes: null, gpuCount: 0, dataDisks: [] };
    assert.equal(await h.api.status('POST', '/admin/grant-bundles', { ...zero, name: h.name('zero') }), 400,
      'zero is not a way to spell unlimited');
    assert.equal(await h.api.status('POST', '/admin/grant-bundles', {
      ...zero, name: h.name('no-total'), memBytes: null, diskBytes: null,
    }), 400, 'the disk total always has a size');
  });

  it('keeps the grant\'s own data-disk list and total through bundle edits, and admits system disks under the total', async () => {
    const own = await h.overrideGrant(user, server, { diskBytes: h.state.rootSizeBytes - 1, dataDisks: [] });
    assert.deepEqual(own.dataDisks, [], 'an empty own list is a real override');
    await h.patchBundle({ id: own.bundleId }, { dataDisks: [{ poolId: server.poolId, capBytes: GIB }] });
    const access = (await effective())!;
    assert.deepEqual(access.dataDisks, [], 'the override shields the grant from the bundle\'s list');
    assert.equal(access.diskBytes, h.state.rootSizeBytes - 1);
    assert.equal(access.rootDiskAvailableBytes, h.state.rootSizeBytes - 1);

    const denied = await (await login(h.state.baseUrl, user.username, user.password)).api.post('/containers', {
      serverId: server.id, imageId: h.state.image.id, name: h.name('total'),
      rootSizeBytes: h.state.rootSizeBytes, memBytes: GIB, powerIntent: 'stopped',
    }).then(() => undefined, (error: unknown) => error);
    assert.ok(denied instanceof ApiError);
    assert.equal(denied.status, 409);
    assert.equal(denied.code, FailureCode.StorageGrantExceeded);
    const back = await h.overrideGrant(user, server, { diskBytes: undefined, dataDisks: undefined });
    assert.deepEqual(back.overrides, {});
    assert.deepEqual(back.dataDisks, [{ poolId: server.poolId, capBytes: GIB }], 'following the bundle again');
  });

  it('picks the cards of a GPU count when a GPU host is configured', async (t) => {
    const gpuServer = h.state.servers.find((entry) => entry.gpuPci);
    if (!gpuServer) {
      t.skip('no server with E2E_SERVER_n_GPU_PCI');
      return;
    }
    const pci = canonicalPciAddress(gpuServer.gpuPci!)!;
    const prior = await h.api.get<ServerGpuDto>(`/servers/${gpuServer.id}/gpu`);
    await h.api.patch(`/servers/${gpuServer.id}/gpu`, { enabled: true });
    if (!prior.enabled) {
      h.defer('restore GPU switch', () => h.api.patch(`/servers/${gpuServer.id}/gpu`, { enabled: false }));
    }
    await h.grantServer(user, gpuServer, { gpuCount: null });
    const all = (await h.api.get<EffectiveAccessDto>(`/users/${user.id}/effective-access`))
      .servers.find((entry) => entry.serverId === gpuServer.id)!;
    assert.equal(all.accessPhase, 'live');
    const cards = all.accessPhase === 'live' ? all.gpuPciAddresses : [];
    assert.ok(cards.includes(pci), 'every card includes the configured one');

    await h.api.patch(`/users/${user.id}/server-grants/${gpuServer.id}`, { overrides: { gpuCount: 1 } });
    const one = (await h.api.get<EffectiveAccessDto>(`/users/${user.id}/effective-access`))
      .servers.find((entry) => entry.serverId === gpuServer.id)!;
    const picked = one.accessPhase === 'live' ? one.gpuPciAddresses : [];
    assert.equal(picked.length, 1);
    assert.ok(cards.includes(picked[0]!));
    const devices = await (await login(h.state.baseUrl, user.username, user.password)).api
      .get<{ items: { pciAddress: string }[] }>(`/servers/${gpuServer.id}/gpus`);
    assert.deepEqual(devices.items.map((device) => device.pciAddress), picked);
  });
});
