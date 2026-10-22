// Another user's resources: the documented 403 (containers, intents,
// bindings, accounts), 404 (volumes, unknown ids) and the empty "mine" lists.
// B holds a valid grant on the same server, so only ownership separates them.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  ContainerPowerIntent,
  type ContainerDto,
  type CursorPaginatedResponse,
  type HttpDomainPoolDto,
  type HttpProxyBindingDto,
  type IntentAcceptedDto,
  type IntentDto,
  type VolumeDto,
} from '@nyabase/common';
import { Api } from '../client/api.js';
import { GIB, Harness, type TestUser } from '../client/harness.js';
import { waitIntent } from '../client/poll.js';

type Case = [method: string, path: string, expected: number, body?: unknown];

describe('cross-user isolation', () => {
  let h: Harness;
  let a: TestUser;
  let b: TestUser;
  let container: ContainerDto;
  let volumeId: string;
  let intentId: string;
  let binding: HttpProxyBindingDto;

  const expectStatuses = async (api: Api, cases: Case[]): Promise<void> => {
    const mismatches: string[] = [];
    for (const [method, path, expected, body] of cases) {
      const got = await api.status(method, path, body);
      if (got !== expected) mismatches.push(`${method} ${path}: expected ${expected}, got ${got}`);
    }
    assert.deepEqual(mismatches, []);
  };

  before(async () => {
    h = await Harness.start();
    a = await h.newUser('owner');
    b = await h.newUser('other');
    for (const user of [a, b]) {
      await h.grantServer(user, h.server);
      await h.grantPool(user, h.server.poolId);
    }
    container = await h.createContainer(a, h.server, { powerIntent: ContainerPowerIntent.Stopped });
    const volume = await a.session.api.post<IntentAcceptedDto>('/volumes', {
      name: h.name('vol'),
      sizeBytes: GIB,
      scope: { kind: 'local', serverId: h.server.id, poolId: h.server.poolId },
    });
    volumeId = volume.resourceId;
    h.defer('delete volume', () => h.deleteVolume(h.api, volumeId));
    await waitIntent(a.session.api, volume);
    const intents = await a.session.api.get<CursorPaginatedResponse<IntentDto>>('/intents');
    intentId = intents.items.find((intent) => intent.resourceId === container.id)!.id;

    const pool = await h.api.post<HttpDomainPoolDto>('/http-proxy/domain-pools', {
      wildcardDomain: `*.iso-${h.state.runId}.nyabase-e2e.test`,
    });
    h.defer('delete domain pool', () => h.api.delete(`/http-proxy/domain-pools/${pool.id}`));
    binding = await a.session.api.post<HttpProxyBindingDto>('/http-proxy/bindings', {
      hostname: `a.iso-${h.state.runId}.nyabase-e2e.test`,
      containerId: container.id,
      targetPort: 8080,
    });
    h.defer('delete binding', () => a.session.api.delete(`/http-proxy/bindings/${binding.id}`).catch(() => undefined));
  });
  after(async () => h?.cleanup());

  it('forbids (or hides) touching another user\'s container', async () => {
    const c = `/containers/${container.id}`;
    await expectStatuses(b.session.api, [
      ['GET', c, 403],
      ['GET', `${c}/volumes`, 403],
      ['GET', `${c}/shared-volumes`, 403],
      ['GET', `${c}/stats`, 403],
      ['POST', `${c}/actions/start`, 403],
      ['POST', `${c}/actions/stop`, 403],
      ['POST', `${c}/actions/restart`, 403],
      ['POST', `${c}/actions/repair-ssh`, 403],
      ['POST', `${c}/actions/delete`, 403],
      // Desired-state edits (limits, root size, GPUs) do not reveal that the container exists.
      ['PATCH', `${c}/limits`, 404, { memBytes: GIB }],
      ['PATCH', `${c}/root-size`, 404, { sizeBytes: 20 * GIB }],
      ['PATCH', `${c}/gpus`, 404, { pciAddresses: [] }],
      ['POST', `${c}/exec-sessions`, 403, {}],
      ['GET', '/containers?scope=all', 403],
    ]);
    assert.deepEqual(await b.session.api.get<ContainerDto[]>('/containers'), []);
    const own = await a.session.api.get<ContainerDto[]>('/containers');
    assert.deepEqual(own.map((entry) => entry.id), [container.id]);
    assert.equal((await h.api.get<ContainerDto>(c)).id, container.id, 'administrators see everything');
  });

  it('answers 404 for volumes and unknown ids, and for attaching foreign volumes', async () => {
    const v = `/volumes/${volumeId}`;
    await expectStatuses(b.session.api, [
      ['GET', v, 404],
      ['PATCH', v, 404, { expectedRevision: 1, name: 'x' }],
      ['DELETE', v, 404],
      ['POST', `/containers/${container.id}/volumes`, 404, { volumeId, containerPath: '/mnt/x', readOnly: false }],
      ['GET', '/volumes?scope=all', 403],
      ['GET', `/containers/${randomUUID()}`, 404],
      ['GET', `/volumes/${randomUUID()}`, 404],
    ]);
    assert.deepEqual(await b.session.api.get<VolumeDto[]>('/volumes'), []);
    assert.equal((await h.api.get<VolumeDto>(v)).id, volumeId);
  });

  it('hides intents and bindings of other users', async () => {
    await expectStatuses(b.session.api, [
      ['GET', `/intents/${intentId}`, 403],
      ['POST', `/intents/${intentId}/retry`, 403, {}],
      ['GET', '/intents?scope=all', 403],
      ['GET', `/intents?resourceType=container&resourceId=${container.id}`, 404],
      ['GET', '/http-proxy/bindings?scope=all', 403],
      ['PATCH', `/http-proxy/bindings/${binding.id}`, 403, { targetPort: 9090 }],
      ['DELETE', `/http-proxy/bindings/${binding.id}`, 403],
      ['POST', '/http-proxy/bindings', 403, {
        hostname: `b.iso-${h.state.runId}.nyabase-e2e.test`, containerId: container.id, targetPort: 8080,
      }],
    ]);
    assert.deepEqual(await b.session.api.get<HttpProxyBindingDto[]>('/http-proxy/bindings'), []);
    assert.equal((await a.session.api.get<IntentDto>(`/intents/${intentId}`)).id, intentId);
  });

  it('keeps accounts, grants and administration closed to ordinary users', async () => {
    await expectStatuses(b.session.api, [
      ['GET', `/users/${a.id}`, 403],
      ['GET', `/users/${a.id}/ssh-keys`, 403],
      ['POST', `/users/${a.id}/ssh-keys`, 403, { name: 'x', keyText: 'ssh-ed25519 AAAA' }],
      ['PATCH', `/users/${a.id}`, 403, { displayName: 'hijacked' }],
      ['DELETE', `/users/${a.id}`, 403],
      ['GET', `/users/${a.id}/effective-access`, 403],
      ['PUT', `/users/${b.id}/server-grants/${h.server.id}`, 403, {
        cpuCores: null, memBytes: null, diskBytes: null, gpuPciAddresses: [], expiresAt: null,
      }],
      ['GET', `/servers/${h.server.id}?scope=all`, 403],
      ['GET', `/images/${h.state.image.id}?scope=all`, 403],
      ['GET', '/admin/ip-pools', 403],
      ['GET', '/admin/groups', 403],
      ['GET', '/audit', 403],
      ['GET', '/admin/system-settings', 403],
    ]);
    await expectStatuses(new Api(h.state.baseUrl), [
      ['GET', '/containers', 401],
      ['GET', '/volumes', 401],
      ['GET', '/servers', 401],
    ]);
  });
});
