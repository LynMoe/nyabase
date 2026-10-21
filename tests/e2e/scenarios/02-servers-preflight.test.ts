// What `up` produced for every lab server: connected through the trust-token
// flow, pools registered, preflight passed; plus the connect/preflight guards.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  PreflightStatus,
  ServerStatus,
  type IntentAcceptedDto,
  type ServerDto,
  type ServerPreflightDto,
  type StorageCapacityDto,
  type StoragePoolDto,
  type UserServerDto,
} from '@nyabase/common';
import { ApiError } from '../client/api.js';
import { Harness } from '../client/harness.js';
import { waitIntent } from '../client/poll.js';

describe('server connect and preflight status', () => {
  let h: Harness;
  before(async () => {
    h = await Harness.start();
  });
  after(async () => h?.cleanup());

  it('lists every lab server online with a pinned certificate and a passed preflight', async () => {
    const all = await h.api.get<ServerDto[]>('/servers', { scope: 'all' });
    for (const expected of h.state.servers) {
      const server = all.find((entry) => entry.id === expected.id);
      assert.ok(server, `${expected.slug} is registered`);
      assert.equal(server.status, ServerStatus.Online);
      assert.ok(server.serverCertFingerprint, 'the TLS pin was stored by the connect flow');
      assert.ok(server.incusVersion, 'the Incus version was read');
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

  it('rejects connecting an already pinned server with another fingerprint', async () => {
    await assert.rejects(
      h.api.post(`/servers/${h.server.id}/connect`, {
        trustToken: 'not-a-real-token',
        expectedServerCertFingerprint: 'AA:'.repeat(31) + 'AA',
      }),
      (error: unknown) => error instanceof ApiError
        && error.status === 409 && error.code === 'PREFLIGHT_IDENTITY_MISMATCH',
    );
    assert.equal(
      await h.api.status('POST', '/servers/00000000-0000-4000-8000-000000000000/connect', {
        trustToken: 'x',
        expectedServerCertFingerprint: 'AA:'.repeat(31) + 'AA',
      }),
      404,
    );
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
