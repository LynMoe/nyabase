import { describe, expect, it } from 'vitest';
import { checkIncusHttp, checkIncusWebSocket, parseIncusPath, type PolicyRequest } from './policy.js';

const INSTANCE = 'nyc-0123456789abcdef0123456789abcdef';
const VOLUME = 'nyv-0123456789abcdef0123456789abcdef';
const ATTACHMENT = 'nyd-0123456789abcdef0123456789abcdef';

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function instanceDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: INSTANCE,
    type: 'container',
    profiles: [],
    source: { type: 'image', fingerprint: 'a'.repeat(64) },
    config: {
      'limits.cpu': '2-3',
      'limits.memory': '1073741824',
      'limits.processes': '4096',
      'security.privileged': 'false',
      'security.idmap.isolated': 'true',
      'security.nesting': 'true',
      'linux.sysctl.net.ipv6.conf.all.disable_ipv6': '1',
      'linux.sysctl.net.ipv6.conf.default.disable_ipv6': '1',
      'user.nyabase.managed': 'true',
    },
    devices: {
      root: { type: 'disk', path: '/', pool: 'default', size: '10737418240', 'limits.read': '500MB' },
      eth0: {
        type: 'nic',
        nictype: 'bridged',
        parent: 'vmbr0',
        name: 'eth0',
        host_name: 'nyh0123456789ab',
        'ipv4.address': '10.0.0.5',
        'security.ipv4_filtering': 'true',
        'security.mac_filtering': 'true',
        'security.port_isolation': 'true',
        'limits.ingress': '1000Mbit',
      },
      [ATTACHMENT]: { type: 'disk', pool: 'default', source: VOLUME, path: '/data' },
      gpu0: { type: 'gpu', gputype: 'physical', pci: '0000:41:00.0' },
    },
    ...overrides,
  };
}

const noCurrent = async (): Promise<undefined> => undefined;

async function check(request: PolicyRequest, current: Record<string, unknown> | undefined = undefined) {
  return checkIncusHttp(request, async () => current);
}

describe('agent Incus policy', () => {
  it('accepts the instance the platform builds', async () => {
    await expect(check({ method: 'POST', path: '/1.0/instances', body: body(instanceDocument()) }))
      .resolves.toEqual({ allowed: true });
  });

  it.each([
    ['raw lxc', { config: { ...instanceDocument().config as object, 'raw.lxc': 'lxc.apparmor.profile=unconfined' } }],
    ['privileged', { config: { ...instanceDocument().config as object, 'security.privileged': 'true' } }],
    ['shared idmap', { config: { ...instanceDocument().config as object, 'security.idmap.isolated': 'false' } }],
    ['kernel modules', { config: { ...instanceDocument().config as object, 'linux.kernel_modules': 'nbd' } }],
    ['cpu count instead of a set', { config: { ...instanceDocument().config as object, 'limits.cpu': '4' } }],
    ['a profile', { profiles: ['default'] }],
    ['no profiles key', { profiles: undefined }],
    ['a host path disk', { devices: { root: { type: 'disk', path: '/', pool: 'p' }, host: { type: 'disk', source: '/', path: '/host' } } }],
    ['an unfiltered nic', { devices: { eth0: { type: 'nic', nictype: 'bridged', parent: 'br0', host_name: 'nyh0123456789ab', 'ipv4.address': '10.0.0.5' } } }],
    ['a nic outside the IPv6 guard', { devices: { eth0: { type: 'nic', nictype: 'bridged', parent: 'br0', host_name: 'veth1', 'ipv4.address': '10.0.0.5', 'security.ipv4_filtering': 'true', 'security.mac_filtering': 'true' } } }],
    ['a proxy device', { devices: { web: { type: 'proxy', listen: 'tcp:0.0.0.0:80', connect: 'tcp:127.0.0.1:80' } } }],
    ['a copy source', { source: { type: 'copy', source: 'other' } }],
  ])('refuses an instance with %s', async (_label, overrides) => {
    const document = instanceDocument(overrides);
    const verdict = await check({ method: 'POST', path: '/1.0/instances', body: body(document) });
    expect(verdict.allowed).toBe(false);
  });

  it('refuses instances that are not nyabase instances', async () => {
    const verdict = await check({
      method: 'POST',
      path: '/1.0/instances',
      body: body(instanceDocument({ name: 'customer-db' })),
    });
    expect(verdict.allowed).toBe(false);
    expect((await check({ method: 'DELETE', path: '/1.0/instances/customer-db' })).allowed).toBe(false);
    expect((await check({ method: 'GET', path: `/1.0/instances/${INSTANCE}` })).allowed).toBe(true);
  });

  it('forces volatile keys back to what Incus holds on update', async () => {
    const current = { config: { 'volatile.idmap.next': '[{"Hostid":1065536}]' } };
    const remapped = instanceDocument({
      config: {
        ...instanceDocument().config as object,
        'volatile.idmap.next': '[{"Hostid":0}]',
        'volatile.invented': 'x',
      },
    });
    const verdict = await check({ method: 'PUT', path: `/1.0/instances/${INSTANCE}`, body: body(remapped) }, current);
    expect(verdict.allowed).toBe(true);
    const sent = JSON.parse((verdict as { body: Buffer }).body.toString()) as { config: Record<string, string> };
    expect(sent.config['volatile.idmap.next']).toBe('[{"Hostid":1065536}]');
    expect(sent.config['volatile.invented']).toBeUndefined();
    expect(sent.config['limits.cpu']).toBe('2-3');
    expect((await check({ method: 'PUT', path: `/1.0/instances/${INSTANCE}`, body: body(remapped) })).allowed)
      .toBe(false);
    const created = instanceDocument({ config: { ...instanceDocument().config as object, 'volatile.idmap.next': '[]' } });
    expect((await check({ method: 'POST', path: '/1.0/instances', body: body(created) })).allowed).toBe(false);
  });

  it('checks PATCH fragments without demanding a whole document', async () => {
    const current = { config: {} };
    expect((await check({
      method: 'PATCH',
      path: `/1.0/instances/${INSTANCE}`,
      body: body({ config: { 'limits.memory': '2147483648' } }),
    }, current)).allowed).toBe(true);
    expect((await check({
      method: 'PATCH',
      path: `/1.0/instances/${INSTANCE}`,
      body: body({ config: { 'raw.idmap': 'both 0 0' } }),
    }, current)).allowed).toBe(false);
  });

  it('allows renames only between nyabase names and refuses migration', async () => {
    const other = 'nyc-ffffffffffffffffffffffffffffffff';
    expect((await check({ method: 'POST', path: `/1.0/instances/${INSTANCE}`, body: body({ name: other }) })).allowed)
      .toBe(true);
    expect((await check({ method: 'POST', path: `/1.0/instances/${INSTANCE}`, body: body({ name: 'x' }) })).allowed)
      .toBe(false);
    expect((await check({
      method: 'POST',
      path: `/1.0/instances/${INSTANCE}`,
      body: body({ name: other, migration: true }),
    })).allowed).toBe(false);
  });

  it('allows power, exec and file operations on nyabase instances', async () => {
    expect((await check({ method: 'PUT', path: `/1.0/instances/${INSTANCE}/state`, body: body({ action: 'start' }) })).allowed)
      .toBe(true);
    expect((await check({ method: 'POST', path: `/1.0/instances/${INSTANCE}/exec`, body: body({ command: ['true'] }) })).allowed)
      .toBe(true);
    expect((await check({ method: 'POST', path: `/1.0/instances/${INSTANCE}/files?path=%2Fetc%2Fhostname`, body: Buffer.from('x') })).allowed)
      .toBe(true);
    expect((await check({ method: 'POST', path: `/1.0/instances/${INSTANCE}/backups`, body: body({}) })).allowed)
      .toBe(false);
  });

  it('keeps custom volumes shifted and refuses foreign volumes', async () => {
    const create = { name: VOLUME, type: 'custom', config: { size: '1073741824', 'security.shifted': 'true' } };
    expect((await check({ method: 'POST', path: '/1.0/storage-pools/default/volumes', body: body(create) })).allowed)
      .toBe(true);
    expect((await check({
      method: 'POST',
      path: '/1.0/storage-pools/default/volumes',
      body: body({ ...create, config: { 'security.unmapped': 'true' } }),
    })).allowed).toBe(false);
    expect((await check({
      method: 'PUT',
      path: `/1.0/storage-pools/default/volumes/custom/${VOLUME}`,
      body: body({ config: { size: '2147483648', 'security.shifted': 'false' } }),
    }, { config: {} })).allowed).toBe(false);
    expect((await check({ method: 'DELETE', path: '/1.0/storage-pools/default/volumes/custom/backups' })).allowed)
      .toBe(false);
    expect((await check({ method: 'DELETE', path: '/1.0/storage-pools/default' })).allowed).toBe(false);
  });

  it('refuses server, trust, profile and network mutation', async () => {
    for (const request of [
      { method: 'PUT', path: '/1.0', body: body({ config: {} }) },
      { method: 'PATCH', path: '/1.0', body: body({ config: { 'core.https_address': ':8443' } }) },
      { method: 'POST', path: '/1.0/certificates', body: body({}) },
      { method: 'GET', path: '/1.0/certificates' },
      { method: 'POST', path: '/1.0/profiles', body: body({ name: 'x' }) },
      { method: 'PUT', path: '/1.0/networks/vmbr0', body: body({}) },
      { method: 'GET', path: '/1.0/instances?project=other' },
      { method: 'GET', path: '/1.0/instances?target=node2' },
    ] as const) {
      expect((await checkIncusHttp(request, noCurrent)).allowed, `${request.method} ${request.path}`).toBe(false);
    }
  });

  it('keeps images private and pulled from a remote', async () => {
    const pull = { source: { type: 'image', server: 'https://images.example', alias: 'ubuntu/24.04', protocol: 'simplestreams' } };
    expect((await check({ method: 'POST', path: '/1.0/images', body: body(pull) })).allowed).toBe(true);
    expect((await check({ method: 'POST', path: '/1.0/images', body: body({ ...pull, public: true }) })).allowed).toBe(false);
    expect((await check({ method: 'POST', path: '/1.0/images/aliases', body: body({ name: 'ubuntu/24.04' }) })).allowed)
      .toBe(true);
    expect((await check({ method: 'DELETE', path: '/1.0/images/aliases/ubuntu%2F24.04' })).allowed).toBe(true);
  });

  it('refuses traversal and encoded separators', () => {
    expect(parseIncusPath('/1.0/instances/../certificates')).toBeUndefined();
    expect(parseIncusPath('/1.0/instances/%2e%2e/certificates')).toBeUndefined();
    expect(parseIncusPath('/1.0//certificates')).toBeUndefined();
    expect(parseIncusPath('/1.0/instances\\x')).toBeUndefined();
  });

  it('opens only event and operation websockets', () => {
    expect(checkIncusWebSocket('/1.0/events').allowed).toBe(true);
    expect(checkIncusWebSocket('/1.0/operations/0b6b2f5e-2f8f-4b64-8a8e-5f4c4c4c4c4c/websocket?secret=abc').allowed)
      .toBe(true);
    expect(checkIncusWebSocket(`/1.0/instances/${INSTANCE}/console`).allowed).toBe(false);
    expect(checkIncusWebSocket('/1.0/operations/0b6b2f5e-2f8f-4b64-8a8e-5f4c4c4c4c4c/websocket').allowed).toBe(false);
  });
});
