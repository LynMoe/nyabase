// Direct and group grants on one server merge into one effective grant:
// quotas take the maximum (unlimited wins), GPUs are the union, the expiry
// is the latest. No container is created; the compute caps are enforced at
// admission, before anything reaches Incus.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  canonicalPciAddress,
  type EffectiveAccessDto,
  type LiveServerAccessDto,
  type GroupDto,
  type PutServerGrantRequest,
  type ServerGpuDto,
} from '@nyabase/common';
import { ApiError, login } from '../client/api.js';
import { GIB, Harness, type TestUser } from '../client/harness.js';
import type { RunServer } from '../client/state.js';

const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

describe('authorization merge', () => {
  let h: Harness;
  let user: TestUser;
  let server: RunServer;
  let firstGroup: GroupDto;
  const grant = (overrides: Partial<PutServerGrantRequest>): PutServerGrantRequest => ({
    cpuCores: 1, memBytes: GIB, diskBytes: 10 * GIB, gpuPciAddresses: [], expiresAt: null, ...overrides,
  });

  const effective = async (): Promise<LiveServerAccessDto | undefined> => {
    const viaAdmin = await h.api.get<EffectiveAccessDto>(`/users/${user.id}/effective-access`);
    // Sign in afresh each time so the self view reflects the latest membership.
    const fresh = await login(h.state.baseUrl, user.username, user.password);
    const viaSelf = await fresh.api.get<EffectiveAccessDto>('/me/access');
    assert.deepEqual(viaSelf.servers, viaAdmin.servers, 'the user sees what the administrator sees');
    const entry = viaAdmin.servers.find((item) => item.serverId === server.id);
    assert.notEqual(entry?.accessPhase, 'grace', 'a grace entry carries no quotas');
    return entry as LiveServerAccessDto | undefined;
  };

  const newGroup = async (label: string): Promise<GroupDto> => {
    const group = await h.api.post<GroupDto>('/admin/groups', { name: h.name(label) });
    h.defer(`delete group ${group.name}`, () => h.api.delete(`/admin/groups/${group.id}`));
    return group;
  };

  before(async () => {
    h = await Harness.start();
    server = h.server;
    user = await h.newUser('merge');
  });
  after(async () => h?.cleanup());

  it('starts without access', async () => {
    assert.equal(await effective(), undefined);
  });

  it('serves the direct grant as is', async () => {
    await h.api.put(`/users/${user.id}/server-grants/${server.id}`, grant({ expiresAt: inDays(30) }));
    h.defer('delete direct grant', () => h.api.delete(`/users/${user.id}/server-grants/${server.id}`));
    const access = await effective();
    assert.ok(access);
    assert.equal(access.cpuCores, 1);
    assert.equal(access.memBytes, GIB);
    assert.equal(access.diskBytes, 10 * GIB);
    assert.equal(access.accessPhase, 'live');
    assert.ok(access.allowedImageIds.includes(h.state.image.id));
  });

  it('takes the maximum of a user grant and a group grant', async () => {
    const group = (firstGroup = await newGroup('g1'));
    await h.api.put(`/admin/groups/${group.id}/server-grants/${server.id}`, grant({
      cpuCores: 2, memBytes: GIB / 2, diskBytes: 20 * GIB, expiresAt: inDays(60),
    }));
    await h.api.post(`/admin/groups/${group.id}/members`, { userId: user.id });
    const access = (await effective())!;
    assert.equal(access.cpuCores, 2);
    assert.equal(access.memBytes, GIB, 'the larger memory is the direct 1 GiB');
    assert.equal(access.diskBytes, 20 * GIB);
    assert.ok(Math.abs(Date.parse(access.expiresAt!) - Date.parse(inDays(60))) < 120_000, 'the latest expiry wins');

    // The merged memory cap, not the smaller group one, is what admission enforces.
    const denied = await (await login(h.state.baseUrl, user.username, user.password)).api.post('/containers', {
      serverId: server.id, imageId: h.state.image.id, name: h.name('cap'),
      rootSizeBytes: h.state.rootSizeBytes, memBytes: GIB + 1, powerIntent: 'running',
    }).then(() => undefined, (error: unknown) => error);
    assert.ok(denied instanceof ApiError);
    assert.equal(denied.status, 403);
    assert.equal(denied.code, 'MEMORY_GRANT_EXCEEDED');
    assert.equal((denied.body as { details: { grantMemBytes: number } }).details.grantMemBytes, GIB);
  });

  it('lets an unlimited grant win and refuses zero as a quota spelling', async () => {
    const group = await newGroup('g2');
    await h.api.put(`/admin/groups/${group.id}/server-grants/${server.id}`, grant({
      cpuCores: null, memBytes: GIB / 4, diskBytes: 5 * GIB, expiresAt: null,
    }));
    await h.api.post(`/admin/groups/${group.id}/members`, { userId: user.id });
    let access = (await effective())!;
    assert.equal(access.cpuCores, null, 'null CPU is unlimited and wins');
    assert.equal(access.memBytes, GIB);
    assert.equal(access.diskBytes, 20 * GIB);
    assert.equal(access.expiresAt, null, 'a grant that never expires wins');

    await h.api.put(`/admin/groups/${group.id}/server-grants/${server.id}`, grant({
      cpuCores: null, memBytes: GIB / 4, diskBytes: null, expiresAt: null,
    }));
    access = (await effective())!;
    assert.equal(access.diskBytes, null, 'null disk is unlimited and wins');
    assert.equal(await h.api.status('PUT', `/admin/groups/${group.id}/server-grants/${server.id}`, grant({
      memBytes: 0, expiresAt: null,
    })), 400, 'zero is not a way to spell unlimited');

    await h.api.delete(`/admin/groups/${group.id}/members/${user.id}`);
    access = (await effective())!;
    assert.equal(access.cpuCores, 2, 'leaving the group drops its contribution');
    assert.equal(access.diskBytes, 20 * GIB);
  });

  it('falls back to the direct grant when the last group is gone', async () => {
    await h.api.delete(`/admin/groups/${firstGroup.id}/members/${user.id}`);
    const access = (await effective())!;
    assert.equal(access.cpuCores, 1);
    assert.equal(access.memBytes, GIB);
    assert.equal(access.diskBytes, 10 * GIB);
  });

  it('unites GPU addresses across grants when a GPU host is configured', async (t) => {
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
    const group = await newGroup('gpu');
    await h.api.post(`/admin/groups/${group.id}/members`, { userId: user.id });
    await h.api.put(`/users/${user.id}/server-grants/${gpuServer.id}`, grant({ gpuPciAddresses: [] }));
    h.defer('delete GPU direct grant', () => h.api.delete(`/users/${user.id}/server-grants/${gpuServer.id}`));
    await h.api.put(`/admin/groups/${group.id}/server-grants/${gpuServer.id}`, grant({ gpuPciAddresses: [pci] }));

    const access = (await h.api.get<EffectiveAccessDto>(`/users/${user.id}/effective-access`))
      .servers.find((entry) => entry.serverId === gpuServer.id)!;
    assert.equal(access.accessPhase, 'live');
    assert.deepEqual(access.accessPhase === 'live' ? access.gpuPciAddresses : [], [pci]);
    const devices = await (await login(h.state.baseUrl, user.username, user.password)).api
      .get<{ items: { pciAddress: string }[] }>(`/servers/${gpuServer.id}/gpus`);
    assert.deepEqual(devices.items.map((device) => device.pciAddress), [pci]);
  });
});
