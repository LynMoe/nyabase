// HTTP proxy: a domain pool, a binding to a port in a running container, and
// requests through the Rust http-proxy listener selected by the Host header.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, it } from 'node:test';
import {
  type ContainerDto,
  type HttpDomainPoolDto,
  type HttpDomainPoolPublicDto,
  type HttpProxyBindingDto,
} from '@nyabase/common';
import { ApiError } from '../client/api.js';
import { Harness, type TestUser } from '../client/harness.js';
import { pollUntil } from '../client/poll.js';

function httpGet(port: number, host: string, hostHeader: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path: '/', headers: { Host: hostHeader }, timeout: 10_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

describe('HTTP proxy binding', () => {
  let h: Harness;
  let user: TestUser;
  let container: ContainerDto;
  let pool: HttpDomainPoolDto;
  let binding: HttpProxyBindingDto;
  let hostname: string;
  const marker = `nyabase-http-${Date.now().toString(36)}`;
  const fetchVia = (name = hostname) => httpGet(h.state.httpProxy.port, h.state.httpProxy.host, name);

  before(async () => {
    h = await Harness.start();
    user = await h.newUser('http');
    await h.addSshKey(user);
    await h.grantServer(user, h.server);
    container = await h.createContainer(user, h.server);
    pool = await h.api.post<HttpDomainPoolDto>('/http-proxy/domain-pools', {
      wildcardDomain: `*.${h.state.runId}.nyabase-e2e.test`,
      enabled: true,
      httpsEnabled: false,
    });
    h.defer('delete domain pool', () => h.api.delete(`/http-proxy/domain-pools/${pool.id}`));
    hostname = `web.${h.state.runId}.nyabase-e2e.test`;
    await h.ssh(user, container, [
      'mkdir -p /tmp/www',
      `echo ${marker} > /tmp/www/index.html`,
      '(setsid nohup python3 -m http.server 8000 --directory /tmp/www >/tmp/www.log 2>&1 < /dev/null &)',
      'sleep 2',
      'echo started',
    ].join(' && '));
  });
  after(async () => h?.cleanup());

  it('offers the enabled pool to users', async () => {
    const pools = await user.session.api.get<HttpDomainPoolPublicDto[]>('/http-proxy/domain-pools');
    assert.ok(pools.some((entry) => entry.id === pool.id));
    assert.equal(await user.session.api.status('POST', '/http-proxy/domain-pools', {
      wildcardDomain: '*.nope.example.test',
    }), 403, 'only administrators manage pools');
  });

  it('binds a hostname to the container and serves the guest through the proxy', async () => {
    const api = user.session.api;
    binding = await api.post<HttpProxyBindingDto>('/http-proxy/bindings', {
      hostname,
      containerId: container.id,
      targetPort: 8000,
    });
    h.defer('delete binding', () => api.delete(`/http-proxy/bindings/${binding.id}`).catch(() => undefined));
    assert.equal(binding.hostname, hostname);
    assert.equal(binding.ownerId, user.id);
    await pollUntil(async () => {
      const [mine] = (await api.get<HttpProxyBindingDto[]>('/http-proxy/bindings')).filter((b) => b.id === binding.id);
      return mine?.status === 'ready' ? mine : undefined;
    }, { what: 'the binding to become ready', timeoutMs: 120_000 });
    const served = await pollUntil(async () => {
      const response = await fetchVia();
      return response.status === 200 ? response : undefined;
    }, { what: 'the proxy to serve the guest', timeoutMs: 90_000, intervalMs: 3_000 });
    assert.match(served.body, new RegExp(marker));
    assert.notEqual((await fetchVia(`unbound.${h.state.runId}.nyabase-e2e.test`)).status, 200,
      'a hostname without a binding is not served');
  });

  it('rejects duplicates, foreign hostnames and bad ports', async () => {
    const api = user.session.api;
    const create = (body: unknown) => api.post('/http-proxy/bindings', body).then(() => 0, (e: unknown) => (e as ApiError).status);
    assert.equal(await create({ hostname, containerId: container.id, targetPort: 8000 }), 409);
    assert.ok(await create({ hostname: 'web.outside-any-pool.example.org', containerId: container.id, targetPort: 8000 }) >= 400);
    assert.equal(await create({ hostname: `p.${h.state.runId}.nyabase-e2e.test`, containerId: container.id, targetPort: 70_000 }), 400);
  });

  it('follows a retargeted port and stops serving once deleted', async () => {
    const api = user.session.api;
    await api.patch<HttpProxyBindingDto>(`/http-proxy/bindings/${binding.id}`, { targetPort: 9 });
    await pollUntil(async () => ((await fetchVia()).status !== 200 ? true : undefined),
      { what: 'the dead port to stop serving', timeoutMs: 60_000, intervalMs: 3_000 });
    await api.patch<HttpProxyBindingDto>(`/http-proxy/bindings/${binding.id}`, { targetPort: 8000 });
    await pollUntil(async () => ((await fetchVia()).status === 200 ? true : undefined),
      { what: 'the port to serve again', timeoutMs: 60_000, intervalMs: 3_000 });

    await api.delete(`/http-proxy/bindings/${binding.id}`);
    await pollUntil(async () => ((await fetchVia()).status !== 200 ? true : undefined),
      { what: 'the deleted binding to stop serving', timeoutMs: 60_000, intervalMs: 3_000 });
    assert.equal((await api.get<HttpProxyBindingDto[]>('/http-proxy/bindings')).some((b) => b.id === binding.id), false);
  });
});
