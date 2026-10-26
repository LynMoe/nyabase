import { describe, expect, it } from 'vitest';
import { OperationLedger } from './operation-ledger.js';
import {
  checkIncusHttp,
  checkIncusWebSocket,
  filterIncusEvent,
  parseIncusPath,
  type CurrentDocumentReader,
  type PolicyRequest,
} from './policy.js';

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
        'limits.ingress': '1000Mbit',
      },
      [ATTACHMENT]: { type: 'disk', pool: 'default', source: VOLUME, path: '/data' },
      gpu0: { type: 'gpu', gputype: 'physical', pci: '0000:41:00.0' },
    },
    ...overrides,
  };
}

const OPERATION = '0b6b2f5e-2f8f-4b64-8a8e-5f4c4c4c4c4c';
const noCurrent = async (): Promise<undefined> => undefined;
const noOperations = new OperationLedger();

function context(readCurrent: CurrentDocumentReader, operations = noOperations) {
  return { readCurrent, operations };
}

async function check(request: PolicyRequest, current: Record<string, unknown> | undefined = undefined) {
  return checkIncusHttp(request, context(async () => current));
}

/*
 * What the Backend actually sends is checked from its side:
 * packages/backend/src/agent-policy.contract.test.ts runs the Backend's real
 * builders and Incus operations through this policy. These tests pin what the
 * policy refuses.
 */
describe('agent Incus policy', () => {
  it('accepts the instance the platform builds', async () => {
    await expect(check({ method: 'POST', path: '/1.0/instances', body: body(instanceDocument({ start: false })) }))
      .resolves.toEqual({ allowed: true, body: body(instanceDocument({ start: false })) });
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
      // A PUT carries InstancePut, not the create-only fields.
      name: undefined,
      type: undefined,
      source: undefined,
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

  it('does not require guest NICs to be port-isolated', async () => {
    const devices = instanceDocument().devices as Record<string, Record<string, string>>;
    const create = (eth0: Record<string, string>) => check({
      method: 'POST',
      path: '/1.0/instances',
      body: body(instanceDocument({ devices: { ...devices, eth0 } })),
    });
    const unisolated = { ...devices.eth0 };
    delete unisolated['security.port_isolation'];
    expect((await create(unisolated)).allowed).toBe(true);
    expect((await create({ ...devices.eth0, 'security.port_isolation': 'false' })).allowed).toBe(true);
    expect((await create({ ...devices.eth0, 'security.port_isolation': 'true' })).allowed).toBe(true);
    expect((await create({ ...devices.eth0, 'security.port_isolation': 'yes' })).allowed).toBe(false);
  });

  it('marks every request that brings a guest NIC up as needing the IPv6 guard', async () => {
    const needs = async (request: PolicyRequest, current?: Record<string, unknown>) => {
      const verdict = await check(request, current);
      expect(verdict.allowed, `${request.method} ${request.path}`).toBe(true);
      return verdict.allowed && verdict.needsIpv6Guard === true;
    };
    const state = (action: string): PolicyRequest =>
      ({ method: 'PUT', path: `/1.0/instances/${INSTANCE}/state`, body: body({ action }) });
    expect(await needs(state('start'))).toBe(true);
    expect(await needs(state('restart'))).toBe(true);
    expect(await needs(state('unfreeze'))).toBe(true);
    expect(await needs(state('stop'))).toBe(false);
    expect(await needs(state('freeze'))).toBe(false);
    expect(await needs({ method: 'POST', path: '/1.0/instances', body: body(instanceDocument({ start: true })) }))
      .toBe(true);
    expect(await needs({ method: 'POST', path: '/1.0/instances', body: body(instanceDocument({ start: false })) }))
      .toBe(false);

    const { eth0, ...withoutNic } = instanceDocument().devices as Record<string, Record<string, string>>;
    const update = (devices: Record<string, unknown>): PolicyRequest => ({
      method: 'PATCH',
      path: `/1.0/instances/${INSTANCE}`,
      body: body({ devices }),
    });
    const running = { status: 'Running', config: {}, devices: withoutNic };
    // A NIC hot-plugged into (or changed on) a live guest needs the guard; an unchanged echo does not.
    expect(await needs(update({ eth0 }), running)).toBe(true);
    expect(await needs(update({ eth0: { ...eth0, 'limits.egress': '10Mbit' } }), { ...running, devices: { eth0 } }))
      .toBe(true);
    expect(await needs(update({ eth0 }), { ...running, devices: { eth0 } })).toBe(false);
    expect(await needs(update({ eth0 }), { ...running, status: 'Stopped' })).toBe(false);
    expect(await needs(update({ root: withoutNic.root }), running)).toBe(false);
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

  it('accepts the platform ownership labels on volumes, but no other user keys', async () => {
    const labels = { 'user.nyabase.managed': 'true', 'user.nyabase.scope': '0b9f3c7e-0000-4000-8000-000000000001' };
    const create = { name: VOLUME, type: 'custom', config: { size: '1073741824', 'security.shifted': 'true', ...labels } };
    expect((await check({ method: 'POST', path: '/1.0/storage-pools/default/volumes', body: body(create) })).allowed)
      .toBe(true);
    expect((await check({
      method: 'PUT',
      path: `/1.0/storage-pools/default/volumes/custom/${VOLUME}`,
      body: body({ config: { size: '2147483648', 'security.shifted': 'true', ...labels } }),
    }, { config: {} })).allowed).toBe(true);
    expect((await check({
      method: 'POST',
      path: '/1.0/storage-pools/default/volumes',
      body: body({ ...create, config: { ...create.config, 'user.other': 'x' } }),
    })).allowed).toBe(false);
  });

  it('refuses volume mounts over kernel pseudo-filesystems', async () => {
    const withMount = (path: string) => instanceDocument({
      devices: {
        ...(instanceDocument().devices as Record<string, unknown>),
        [ATTACHMENT]: { type: 'disk', pool: 'default', source: VOLUME, path },
      },
    });
    for (const path of ['/proc', '/proc/sys', '/sys', '/sys/fs/cgroup', '/dev', '/dev/shm', '//proc', '/dev/', '/./sys', '/data/../proc']) {
      const verdict = await check({ method: 'POST', path: '/1.0/instances', body: body(withMount(path)) });
      expect(verdict.allowed, path).toBe(false);
    }
    for (const path of ['/data', '/procfs', '/srv/dev', '/system']) {
      const verdict = await check({ method: 'POST', path: '/1.0/instances', body: body(withMount(path)) });
      expect(verdict.allowed, path).toBe(true);
    }
  });

  it('requires a volume PUT to keep security.shifted, like PATCH', async () => {
    const path = `/1.0/storage-pools/default/volumes/custom/${VOLUME}`;
    const current = { config: { size: '1073741824', 'security.shifted': 'true' } };
    for (const config of [{ size: '2147483648' }, undefined]) {
      expect((await check({ method: 'PUT', path, body: body(config ? { config } : { description: '' }) }, current)).allowed)
        .toBe(false);
    }
    expect((await check({ method: 'PUT', path, body: body({ config: { size: '2147483648', 'security.shifted': 'true' } }) }, current)).allowed)
      .toBe(true);
    // A PATCH that leaves the key out leaves it as it is.
    expect((await check({ method: 'PATCH', path, body: body({ config: { size: '2147483648' } }) }, current)).allowed)
      .toBe(true);
    expect((await check({ method: 'PATCH', path, body: body({ config: { 'security.shifted': null } }) }, current)).allowed)
      .toBe(false);
  });

  it('lets an update echo config Incus already holds, but not change or add it', async () => {
    const path = `/1.0/storage-pools/default/volumes/custom/${VOLUME}`;
    // What a pool with volume.zfs.* / volume.snapshots.* defaults gives every new volume.
    const poolDefaults = { 'zfs.use_refquota': 'true', 'snapshots.schedule': '@daily' };
    const current = { config: { size: '1073741824', 'security.shifted': 'true', ...poolDefaults } };
    const put = (config: Record<string, string>) => check({ method: 'PUT', path, body: body({ config }) }, current);
    expect((await put({ size: '2147483648', 'security.shifted': 'true', ...poolDefaults })).allowed).toBe(true);
    expect((await put({ size: '2147483648', 'security.shifted': 'true', 'zfs.use_refquota': 'false' })).allowed)
      .toBe(false);
    expect((await put({ size: '2147483648', 'security.shifted': 'true', 'zfs.blocksize': '16KiB' })).allowed)
      .toBe(false);
    // Nothing is "unchanged" on create.
    expect((await check({
      method: 'POST',
      path: '/1.0/storage-pools/default/volumes',
      body: body({ name: VOLUME, type: 'custom', config: { size: '1073741824', 'security.shifted': 'true', ...poolDefaults } }),
    }, current)).allowed).toBe(false);

    const instancePath = `/1.0/instances/${INSTANCE}`;
    const { config } = instanceDocument() as { config: Record<string, string> };
    const held = { status: 'Stopped', config: { ...config, 'boot.autostart': 'false' } };
    const update = (extra: Record<string, string>) => check({
      method: 'PATCH',
      path: instancePath,
      body: body({ config: { ...config, ...extra } }),
    }, held);
    expect((await update({ 'boot.autostart': 'false' })).allowed).toBe(true);
    expect((await update({ 'boot.autostart': 'true' })).allowed).toBe(false);
    expect((await update({ 'raw.lxc': 'lxc.apparmor.profile=unconfined' })).allowed).toBe(false);
    // A whole document must still keep the uid shift, whatever the instance holds now.
    const shiftless = { ...config, 'security.idmap.isolated': 'false' };
    expect((await check({
      method: 'PUT',
      path: instancePath,
      body: body({ ...instanceDocument({ config: shiftless }), name: undefined, type: undefined, source: undefined }),
    }, { status: 'Stopped', config: shiftless })).allowed).toBe(false);
  });

  it('pulls images only from https simplestreams servers, internal mirrors included', async () => {
    const pull = (server: unknown, protocol: string | null = 'simplestreams') => check({
      method: 'POST',
      path: '/1.0/images',
      body: body({ source: { type: 'image', server, alias: 'ubuntu/24.04', ...(protocol ? { protocol } : {}) } }),
    });
    for (const server of [
      'https://images.linuxcontainers.org',
      'https://nyabase-images.example.workers.dev/',
      // In-house mirrors: the host is dedicated to nyabase, and the settings accept these too.
      'https://10.0.0.8:8443',
      'https://[fd00::1]/images/',
      'https://mirror',
      'https://registry.internal',
      'https://nas.local',
      'https://mirror.lan',
    ]) {
      expect((await pull(server)).allowed, server).toBe(true);
    }
    for (const server of [
      'http://images.example.com',
      'https://user:pw@images.example.com',
      'https://images.example.com/?stream=x',
      'https://images.example.com/#x',
      'unix:///var/lib/incus/unix.socket',
      'not a url',
      42,
    ]) {
      expect((await pull(server)).allowed, String(server)).toBe(false);
    }
    expect((await pull('https://images.example.com', 'incus')).allowed).toBe(false);
    expect((await pull('https://images.example.com', null)).allowed).toBe(false);
    // Instance creation from a remote image is held to the same rule.
    const create = (server: string) => check({
      method: 'POST',
      path: '/1.0/instances',
      body: body(instanceDocument({ source: { type: 'image', alias: 'debian/12', server, protocol: 'simplestreams' } })),
    });
    expect((await create('https://images.example.com')).allowed).toBe(true);
    expect((await create('https://192.168.1.10')).allowed).toBe(true);
    expect((await create('http://192.168.1.10')).allowed).toBe(false);
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
      expect((await checkIncusHttp(request, context(noCurrent))).allowed, `${request.method} ${request.path}`).toBe(false);
    }
  });

  it('keeps images private and pulled from a remote', async () => {
    const pull = { source: { type: 'image', server: 'https://images.example', alias: 'ubuntu/24.04', protocol: 'simplestreams' } };
    expect((await check({ method: 'POST', path: '/1.0/images', body: body(pull) })).allowed).toBe(true);
    expect((await check({ method: 'POST', path: '/1.0/images', body: body({ ...pull, public: true }) })).allowed).toBe(false);
    const alias = { name: 'ubuntu/24.04', target: 'a'.repeat(64), type: 'container' };
    expect((await check({ method: 'POST', path: '/1.0/images/aliases', body: body(alias) })).allowed).toBe(true);
    expect((await check({ method: 'DELETE', path: '/1.0/images/aliases/ubuntu%2F24.04' })).allowed).toBe(true);
    expect((await check({ method: 'PUT', path: '/1.0/images/aliases/ubuntu%2F24.04', body: body(alias) })).allowed)
      .toBe(false);
    expect((await check({ method: 'PUT', path: `/1.0/images/${'a'.repeat(64)}`, body: body({ public: false }) })).allowed)
      .toBe(false);
  });

  it('refuses traversal and encoded separators', () => {
    expect(parseIncusPath('/1.0/instances/../certificates')).toBeUndefined();
    expect(parseIncusPath('/1.0/instances/%2e%2e/certificates')).toBeUndefined();
    expect(parseIncusPath('/1.0//certificates')).toBeUndefined();
    expect(parseIncusPath('/1.0/instances\\x')).toBeUndefined();
  });

  it('refuses a second query separator whose tail Incus would still read', async () => {
    for (const request of [
      { method: 'GET', path: '/1.0/instances??&all-projects=true' },
      { method: 'GET', path: '/1.0/instances?recursion=1?all-projects=true' },
      { method: 'DELETE', path: `/1.0/instances/${INSTANCE}?recursion=1?&project=other` },
      { method: 'POST', path: `/1.0/instances/${INSTANCE}/exec??&project=other`, body: body({ command: ['true'] }) },
    ] as const) {
      expect((await checkIncusHttp(request, context(async () => ({ config: {} })))).allowed, request.path).toBe(false);
    }
    expect(checkIncusWebSocket('/1.0/events??&all-projects=true&type=logging', noOperations).allowed).toBe(false);
    expect(parseIncusPath('/1.0/instances?recursion=1&project=default')).toBeDefined();
  });

  it('opens only the event stream and channels of operations the agent started', () => {
    const started = new OperationLedger();
    started.record(OPERATION);
    expect(checkIncusWebSocket('/1.0/events', noOperations)).toEqual({ allowed: true, kind: 'events' });
    expect(checkIncusWebSocket(`/1.0/operations/${OPERATION}/websocket?secret=abc`, started))
      .toEqual({ allowed: true, kind: 'operation' });
    // The host operator's own `incus exec`: its id and secret leak nothing through the agent.
    expect(checkIncusWebSocket(`/1.0/operations/${OPERATION}/websocket?secret=abc`, noOperations).allowed).toBe(false);
    expect(checkIncusWebSocket(`/1.0/instances/${INSTANCE}/console`, started).allowed).toBe(false);
    expect(checkIncusWebSocket(`/1.0/operations/${OPERATION}/websocket`, started).allowed).toBe(false);
  });

  it('reaches only operations the agent started, and only to read and wait', async () => {
    const started = new OperationLedger();
    started.record(OPERATION);
    const operation = (method: 'GET' | 'DELETE', path: string, operations = started) =>
      checkIncusHttp({ method, path }, context(noCurrent, operations));
    expect((await operation('GET', `/1.0/operations/${OPERATION}`)).allowed).toBe(true);
    expect((await operation('GET', `/1.0/operations/${OPERATION}/wait?timeout=30`)).allowed).toBe(true);
    // Unknown operations look like Incus' own 404, not like a policy refusal.
    expect(await operation('GET', `/1.0/operations/${OPERATION}`, noOperations))
      .toMatchObject({ allowed: false, notFound: true });
    expect(await operation('GET', `/1.0/operations/${OPERATION}/wait`, noOperations))
      .toMatchObject({ allowed: false, notFound: true });
    expect((await operation('DELETE', `/1.0/operations/${OPERATION}`)).allowed).toBe(false);
    expect((await operation('GET', '/1.0/operations')).allowed).toBe(false);
    expect((await operation('GET', '/1.0/operations?recursion=1')).allowed).toBe(false);
  });

  it('relays lifecycle events of nyabase resources only, without who caused them', () => {
    const event = (source: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      type: 'lifecycle',
      timestamp: '2026-10-23T00:00:00Z',
      metadata: { action: 'instance-started', source, requestor: { username: 'root', address: '@' }, context: {} },
      ...extra,
    });
    expect(JSON.parse(filterIncusEvent(event(`/1.0/instances/${INSTANCE}`))!)).toEqual({
      type: 'lifecycle',
      timestamp: '2026-10-23T00:00:00Z',
      metadata: { action: 'instance-started', source: `/1.0/instances/${INSTANCE}` },
    });
    expect(filterIncusEvent(event(`/1.0/storage-pools/default/volumes/custom/${VOLUME}`))).toBeDefined();
    expect(filterIncusEvent(event('/1.0/instances/customer-db'))).toBeUndefined();
    expect(filterIncusEvent(event('/1.0/storage-pools/default/volumes/custom/backups'))).toBeUndefined();
    expect(filterIncusEvent(event(`/1.0/instances/${INSTANCE}`, { type: 'operation' }))).toBeUndefined();
    expect(filterIncusEvent(event(`/1.0/instances/${INSTANCE}`, { type: 'logging' }))).toBeUndefined();
    expect(filterIncusEvent('not json')).toBeUndefined();
  });
});

/*
 * Incus decodes bodies with Go encoding/json: struct fields match
 * case-insensitively and duplicate keys merge into one map. The policy must
 * refuse anything outside the exact field lists and forward only the body it
 * re-serialized from the object it checked.
 */
describe('agent Incus policy body forwarding', () => {
  const safeTail = `"config":${JSON.stringify(instanceDocument().config)},"devices":${JSON.stringify(instanceDocument().devices)}`;
  const createHead = `"name":"${INSTANCE}","source":{"type":"image","fingerprint":"${'a'.repeat(64)}"},"profiles":[]`;
  const hostDisk = '{"host":{"type":"disk","source":"/","path":"/host"}}';

  function sent(verdict: Awaited<ReturnType<typeof check>>): string {
    expect(verdict.allowed).toBe(true);
    const forwarded = (verdict as { body?: Buffer }).body;
    expect(forwarded).toBeDefined();
    return forwarded!.toString('utf8');
  }

  it('refuses case variants of instance fields that Go would decode into config and devices', async () => {
    const raw = `{${createHead},"Config":{"security.privileged":"true","raw.lxc":"lxc.apparmor.profile=unconfined"},"Devices":${hostDisk},${safeTail}}`;
    const verdict = await check({ method: 'POST', path: '/1.0/instances', body: Buffer.from(raw) });
    expect(verdict).toMatchObject({ allowed: false });
    for (const key of ['CONFIG', 'Profiles', 'Ephemeral', 'Source', 'Description']) {
      const variant = `{${createHead},"${key}":{},${safeTail}}`;
      expect((await check({ method: 'POST', path: '/1.0/instances', body: Buffer.from(variant) })).allowed, key)
        .toBe(false);
    }
  });

  it('forwards only the re-serialized document when keys are duplicated', async () => {
    const raw = `{${createHead},"config":{"security.privileged":"true"},"devices":${hostDisk},${safeTail}}`;
    const forwarded = sent(await check({ method: 'POST', path: '/1.0/instances', body: Buffer.from(raw) }));
    expect(forwarded).toBe(JSON.stringify(JSON.parse(raw)));
    expect(forwarded).not.toContain('"security.privileged":"true"');
    expect(forwarded).not.toContain('/host');
  });

  it('refuses unknown or case-variant keys inside the image source', async () => {
    for (const source of [
      { type: 'image', fingerprint: 'a'.repeat(64), Type: 'copy' },
      { type: 'image', alias: 'x', certificate: 'pem' },
      { type: 'image', alias: 'x', mode: 'push' },
    ]) {
      const verdict = await check({ method: 'POST', path: '/1.0/instances', body: body(instanceDocument({ source })) });
      expect(verdict.allowed, JSON.stringify(source)).toBe(false);
    }
  });

  it('refuses unknown fields on every other JSON endpoint', async () => {
    const current = { config: {} };
    const volumePath = `/1.0/storage-pools/default/volumes/custom/${VOLUME}`;
    for (const request of [
      { method: 'POST', path: `/1.0/instances/${INSTANCE}`, body: body({ name: INSTANCE, Migration: true }) },
      { method: 'POST', path: `/1.0/instances/${INSTANCE}`, body: body({ Name: 'customer-db', name: INSTANCE }) },
      { method: 'PUT', path: `/1.0/instances/${INSTANCE}`, body: body({ ...instanceDocument(), name: undefined, source: undefined, type: undefined, Config: { 'security.privileged': 'true' } }) },
      { method: 'PATCH', path: `/1.0/instances/${INSTANCE}`, body: body({ Devices: JSON.parse(hostDisk) }) },
      { method: 'PATCH', path: `/1.0/instances/${INSTANCE}`, body: body({ stateful: true }) },
      { method: 'PUT', path: `/1.0/instances/${INSTANCE}/state`, body: body({ action: 'stop', Stateful: true }) },
      { method: 'POST', path: `/1.0/instances/${INSTANCE}/exec`, body: body({ command: ['true'], environment: { LD_PRELOAD: '/x' } }) },
      { method: 'POST', path: `/1.0/instances/${INSTANCE}/exec`, body: body({ command: ['true'], Cwd: '/' }) },
      { method: 'POST', path: `/1.0/instances/${INSTANCE}/exec`, body: body({ command: 'true' }) },
      { method: 'POST', path: '/1.0/storage-pools/default/volumes', body: body({ name: VOLUME, config: {}, Source: { type: 'copy' } }) },
      { method: 'POST', path: '/1.0/storage-pools/default/volumes', body: body({ name: VOLUME, config: {}, CONFIG: { 'security.shifted': 'false' } }) },
      { method: 'PUT', path: volumePath, body: body({ config: {}, restore: 'snap0' }) },
      { method: 'PATCH', path: volumePath, body: body({ Config: { 'security.unmapped': 'true' } }) },
      { method: 'POST', path: '/1.0/images', body: body({ source: { type: 'image', server: 'https://x' }, Public: true }) },
      { method: 'POST', path: '/1.0/images', body: body({ source: { type: 'image', server: 'https://x', Secret: 's' } }) },
      { method: 'POST', path: '/1.0/images/aliases', body: body({ name: 'x', target: 'a'.repeat(64), Description: 'd' }) },
    ] as const) {
      const verdict = await checkIncusHttp(request, context(async () => current));
      expect(verdict.allowed, `${request.method} ${request.path} ${request.body.toString()}`).toBe(false);
    }
  });

  it('forwards file content as is and no body where none belongs', async () => {
    const content = Buffer.from('{"Config":{}}');
    const write = await check({ method: 'POST', path: `/1.0/instances/${INSTANCE}/files?path=%2Fetc%2Fx`, body: content });
    expect(write).toEqual({ allowed: true, body: content });
    const remove = await check({ method: 'DELETE', path: `/1.0/instances/${INSTANCE}`, body: body({ force: true }) });
    expect(remove).toEqual({ allowed: true });
  });
});
