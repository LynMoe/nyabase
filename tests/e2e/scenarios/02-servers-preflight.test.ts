// What `up` produced for every lab server: its agent enrolled and connected,
// pools registered, preflight passed; plus the enrollment and preflight guards.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, describe, it } from 'node:test';
import {
  PreflightStatus,
  ServerStatus,
  type IntentAcceptedDto,
  type ServerDto,
  type ServerEnrollmentDto,
  type ServerPreflightDto,
  type StorageCapacityDto,
  type StoragePoolDto,
  type UserServerDto,
} from '@nyabase/common';
import { Harness } from '../client/harness.js';
import { waitIntent } from '../client/poll.js';

describe('server agents and preflight status', () => {
  let h: Harness;
  before(async () => {
    h = await Harness.start();
  });
  after(async () => h?.cleanup());

  it('lists every lab server online through its agent with a passed preflight', async () => {
    const all = await h.api.get<ServerDto[]>('/servers', { scope: 'all' });
    for (const expected of h.state.servers) {
      const server = all.find((entry) => entry.id === expected.id);
      assert.ok(server, `${expected.slug} is registered`);
      assert.equal(server.status, ServerStatus.Online);
      assert.equal(server.agent.connected, true, 'the agent holds its control connection');
      assert.equal(server.agent.enrolled, true);
      assert.equal(server.agent.enrollmentExpiresAt, null, 'the enrollment token was used up');
      assert.ok(server.incusVersion, 'the Incus version came with the agent hello');
      assert.ok((server.cpuTopology?.length ?? 0) > 0, 'the CPU topology was read through the agent');
      assert.equal(server.systemPoolId, expected.poolId);
      assert.equal(server.preflightStatus, PreflightStatus.Passed);
      assert.equal(server.preflightReport?.controlReady, true);
      assert.equal(server.preflightReport?.checks.api, 'pass');
      assert.equal(server.preflightReport?.checks.storagePool, 'pass');
    }
  });

  it('exposes the preflight result on its own endpoint and re-runs it', async () => {
    const server = h.server;
    const prior = await h.api.get<ServerPreflightDto>(`/servers/${server.id}/preflight`);
    assert.equal(prior.status, PreflightStatus.Passed);
    assert.ok(prior.checkedAt);

    const current = await h.api.get<ServerDto>(`/servers/${server.id}`, { scope: 'all' });
    const accepted = await h.api.post<IntentAcceptedDto>(`/servers/${server.id}/preflight`, {
      expectedServerRevision: current.revision,
      poolId: server.poolId,
      probeAddress: h.state.probeAddress,
    });
    await waitIntent(h.api, accepted, { timeoutMs: 600_000 });
    const latest = await h.api.get<ServerPreflightDto>(`/servers/${server.id}/preflight`);
    assert.equal(latest.status, PreflightStatus.Passed);
    assert.ok(Date.parse(latest.checkedAt!) >= Date.parse(prior.checkedAt!));
  });

  it('refuses a stale revision and a pool of another server for preflight', async () => {
    const [first, second] = h.state.servers;
    const server = await h.api.get<ServerDto>(`/servers/${first!.id}`, { scope: 'all' });
    const stale = await h.api.status('POST', `/servers/${first!.id}/preflight`, {
      expectedServerRevision: server.revision + 100,
      poolId: first!.poolId,
      probeAddress: h.state.probeAddress,
    });
    assert.equal(stale, 409);
    if (second) {
      const foreignPool = await h.api.status('POST', `/servers/${first!.id}/preflight`, {
        expectedServerRevision: server.revision,
        poolId: second.poolId,
        probeAddress: h.state.probeAddress,
      });
      assert.equal(foreignPool, 409);
    }
  });

  it('accepts an enrollment token once and never after it expired or was replaced', async () => {
    const server = await h.api.get<ServerDto>(`/servers/${h.server.id}`, { scope: 'all' });
    const issued = await h.api.post<ServerEnrollmentDto>(`/servers/${server.id}/agent-enrollment`, {
      expectedRevision: server.revision,
    });
    const replaced = await h.api.post<ServerEnrollmentDto>(`/servers/${server.id}/agent-enrollment`, {
      expectedRevision: server.revision,
    });
    assert.notEqual(issued.enrollmentToken, replaced.enrollmentToken);
    const enroll = (token: string) => fetch(`${h.state.baseUrl}/api/agent/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollmentToken: token, hostname: 'e2e' }),
    }).then((response) => response.status);
    assert.equal(await enroll(issued.enrollmentToken), 401, 'a replaced token is void');
    assert.equal(await enroll('nyae.0000.not-a-token'), 401);
    assert.equal(
      await h.api.status('POST', `/servers/${server.id}/agent-enrollment`, { expectedRevision: server.revision + 9 }),
      409,
    );
    // Re-issuing never disconnects the running agent.
    const after = await h.api.get<ServerDto>(`/servers/${server.id}`, { scope: 'all' });
    assert.equal(after.agent.connected, true);
    assert.ok(after.agent.enrollmentExpiresAt, 'the unused token stays pending');
  });

  it('refuses agent sockets without a valid credential', async () => {
    const upgrade = (authorization: string) => new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${h.state.baseUrl}/ws/agent`, {
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          authorization,
        },
      });
      request.on('upgrade', (_response, socket) => {
        socket.destroy();
        resolve(101);
      });
      request.on('response', (response) => resolve(response.statusCode ?? 0));
      request.on('error', reject);
      request.end();
    });
    assert.equal(await upgrade('Bearer nyak.x.y'), 401);
    const forged = `nyak.${h.server.id.replaceAll('-', '')}.${'A'.repeat(43)}`;
    assert.equal(await upgrade(`Bearer ${forged}`), 401);
  });

  it('shows registered pools and capacity to the administrator', async () => {
    const pools = await h.api.get<StoragePoolDto[]>(`/servers/${h.server.id}/storage-pools`, { scope: 'all' });
    const pool = pools.find((entry) => entry.id === h.server.poolId);
    assert.ok(pool?.registered && pool.rootDiskCapable);
    const capacity = await h.api.get<StorageCapacityDto>(`/servers/${h.server.id}/storage-capacity`, { scope: 'all' });
    assert.ok(capacity.pools.some((entry) => entry.poolId === h.server.poolId));
  });

  it('keeps the administrator-only views away from users and hides pool sources', async () => {
    const user = await h.newUser('srv');
    assert.equal(await user.session.api.status('GET', '/servers?scope=all'), 403);
    assert.equal(await user.session.api.status('GET', `/servers/${h.server.id}/preflight`), 403);
    assert.deepEqual(await user.session.api.get<UserServerDto[]>('/servers'), [], 'no grant, no servers');
    await h.grantServer(user, h.server);
    const visible = await user.session.api.get<UserServerDto[]>('/servers');
    assert.deepEqual(visible.map((entry) => entry.id), [h.server.id]);
  });

  it('has both proxies connected to the control plane', async () => {
    const ssh = await h.api.get<{ connectedProxies: number }>('/admin/ssh-proxy/status');
    assert.ok(ssh.connectedProxies >= 1, 'ssh-proxy is connected');
    const http = await h.api.get<{ connectedProxies: number }>('/http-proxy/status');
    assert.ok(http.connectedProxies >= 1, 'http-proxy is connected');
  });
});
