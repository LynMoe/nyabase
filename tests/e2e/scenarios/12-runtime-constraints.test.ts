// What the platform enforces on every instance: per-user CPU sets, reserved
// CPUs, aggregate memory, uniform process/network/disk limits, uid-isolated
// maps, guest IPv6 off, and the full scan reverting changes made behind its back.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AuditListResponse, ContainerDto, ServerDto } from '@nyabase/common';
import { GIB, Harness, type TestUser } from '../client/harness.js';
import { pollUntil } from '../client/poll.js';

interface InstanceDocument {
  config: Record<string, string>;
  devices: Record<string, Record<string, string>>;
  profiles: string[];
}

describe('runtime constraints on managed instances', () => {
  let h: Harness;
  let alice: TestUser;
  let bob: TestUser;
  let aliceOne: ContainerDto;
  let aliceTwo: ContainerDto;
  let bobOne: ContainerDto;
  const instance = async (container: ContainerDto): Promise<InstanceDocument> =>
    JSON.parse(await h.incus(h.server, ['query', `/1.0/instances/${container.instanceName}`])) as InstanceDocument;
  const initPid = async (container: ContainerDto): Promise<number> =>
    (JSON.parse(await h.incus(h.server, ['query', `/1.0/instances/${container.instanceName}/state`])) as { pid: number }).pid;
  const fresh = (user: TestUser, container: ContainerDto) =>
    user.session.api.get<ContainerDto>(`/containers/${container.id}`);

  before(async () => {
    h = await Harness.start();
    alice = await h.newUser('cpu-a');
    bob = await h.newUser('cpu-b');
    await h.addSshKey(alice);
    await h.grantServer(alice, h.server, { cpuCores: 2, memBytes: 3 * GIB });
    await h.grantServer(bob, h.server, { cpuCores: 2, memBytes: 2 * GIB });
    aliceOne = await h.createContainer(alice, h.server);
    aliceTwo = await h.createContainer(alice, h.server);
    bobOne = await h.createContainer(bob, h.server);
  });
  after(async () => h?.cleanup());

  it('pins all of a user\'s containers to one CPU set and keeps users apart', async () => {
    const a1 = await h.waitContainer(alice.session.api, aliceOne.id, (c) => c.cpuSet !== null, 'a CPU set');
    const a2 = await h.waitContainer(alice.session.api, aliceTwo.id, (c) => c.cpuSet !== null, 'a CPU set');
    const b1 = await h.waitContainer(bob.session.api, bobOne.id, (c) => c.cpuSet !== null, 'a CPU set');
    assert.equal(a1.cpuSet!.length, 2);
    assert.deepEqual(a1.cpuSet, a2.cpuSet, 'both of alice\'s containers share her set');
    assert.equal(b1.cpuSet!.length, 2);
    const server = await h.api.get<ServerDto>(`/servers/${h.server.id}`, { scope: 'all' });
    const free = (server.cpuTopology ?? []).length - server.reservedCpus.length;
    if (free >= 4) {
      assert.deepEqual(a1.cpuSet!.filter((cpu) => b1.cpuSet!.includes(cpu)), [], 'sets do not overlap while CPUs are free');
    }
    const limit = (await instance(aliceOne)).config['limits.cpu'];
    assert.match(limit ?? '', /^\d+-\d+(,\d+-\d+)*$/, 'limits.cpu is an explicit set, never a count');
    const effective = (await h.onHost(
      h.server,
      `cat /sys/fs/cgroup/lxc.payload.${aliceOne.instanceName}/cpuset.cpus.effective`,
    )).trim();
    const expanded = effective.split(',').flatMap((part) => {
      const [start, end = start] = part.split('-').map(Number);
      return Array.from({ length: end! - start! + 1 }, (_, i) => start! + i);
    });
    assert.deepEqual(expanded, a1.cpuSet, 'the kernel cpuset is the user\'s set');
  });

  it('moves containers off a CPU once it is reserved, without a restart', async () => {
    const before = (await fresh(alice, aliceOne)).cpuSet!;
    const reservedCpu = before[0]!;
    const pids = new Map<string, number>();
    for (const container of [aliceOne, aliceTwo, bobOne]) pids.set(container.id, await initPid(container));
    const server = await h.api.get<ServerDto>(`/servers/${h.server.id}`, { scope: 'all' });
    const original = server.reservedCpus;
    await h.api.patch(`/servers/${h.server.id}`, {
      expectedRevision: server.revision,
      reservedCpus: [...original, reservedCpu],
    });
    h.defer('restore reserved CPUs', async () => {
      const current = await h.api.get<ServerDto>(`/servers/${h.server.id}`, { scope: 'all' });
      await h.api.patch(`/servers/${h.server.id}`, { expectedRevision: current.revision, reservedCpus: original });
    });
    for (const [user, container] of [[alice, aliceOne], [alice, aliceTwo], [bob, bobOne]] as const) {
      const moved = await pollUntil(async () => {
        const current = await fresh(user, container);
        return current.cpuSet && !current.cpuSet.includes(reservedCpu) ? current : undefined;
      }, { what: `${container.name} to leave CPU ${reservedCpu}`, timeoutMs: 120_000, intervalMs: 3_000 });
      assert.equal(moved.cpuSet!.length, 2);
      assert.equal(await initPid(container), pids.get(container.id), 'the instance was not restarted');
    }
  });

  it('counts memory across all of a user\'s containers', async () => {
    const status = await alice.session.api.status('POST', '/containers', {
      serverId: h.server.id,
      imageId: h.state.image.id,
      name: h.name('mem'),
      rootSizeBytes: h.state.rootSizeBytes,
      memBytes: 2 * GIB,
      powerIntent: 'stopped',
    });
    assert.equal(status, 403, '1 GiB + 1 GiB + 2 GiB exceeds the 3 GiB grant');
  });

  it('applies the uniform limits, an isolated uid map and the IPv6 guard', async () => {
    const one = await instance(aliceOne);
    const two = await instance(aliceTwo);
    assert.deepEqual(one.profiles, []);
    assert.equal(one.config['security.idmap.isolated'], 'true');
    assert.equal(one.config['security.privileged'], 'false');
    assert.match(one.config['limits.processes'] ?? '', /^\d+$/);
    assert.equal(one.config['linux.sysctl.net.ipv6.conf.all.disable_ipv6'], '1');
    assert.notEqual(
      one.config['volatile.idmap.base'],
      two.config['volatile.idmap.base'],
      'each container gets its own host uid range',
    );
    const eth0 = one.devices.eth0!;
    assert.match(eth0.host_name ?? '', /^nyh[0-9a-f]{12}$/);
    assert.equal(eth0['security.port_isolation'], 'true');
    assert.match(eth0['limits.ingress'] ?? '', /^\d+Mbit$/);
    assert.match(eth0['limits.egress'] ?? '', /^\d+Mbit$/);
    assert.match(one.devices.root!['limits.read'] ?? '', /^\d+MB$/);
    const guard = await h.onHost(h.server, 'nft list table bridge nyabase_guard');
    const drops = guard.split('\n').filter((line) => /(iif|oif)name "nyh\*" ether type \{.*\} drop/.test(line));
    assert.equal(drops.length, 4, 'forward both ways, input and output');
    for (const line of drops) {
      for (const type of ['ip6', '8021q', '8021ad']) assert.ok(line.includes(type), `${line.trim()} drops ${type}`);
    }
    const guest = await h.ssh(alice, aliceOne, 'cat /proc/sys/net/ipv6/conf/all/disable_ipv6; ip -6 addr show scope global | wc -l');
    assert.deepEqual(guest.trim().split(/\s+/), ['1', '0'], 'no global IPv6 inside the guest');
  });

  it('reverts config, devices and profiles changed outside the platform', async () => {
    const name = aliceOne.instanceName!;
    await h.incus(h.server, ['config', 'set', name, 'raw.lxc=lxc.apparmor.profile=unconfined']);
    await h.incus(h.server, ['config', 'set', name, 'limits.cpu=0-7']);
    await h.incus(h.server, ['config', 'device', 'add', name, 'hostroot', 'disk', 'source=/', 'path=/mnt/hostroot']);
    await h.incus(h.server, ['profile', 'add', name, 'default']);
    const expectedCpus = (await fresh(alice, aliceOne)).cpuSet!;
    const reverted = await pollUntil(async () => {
      const current = await instance(aliceOne);
      return current.config['raw.lxc'] === undefined
        && current.devices.hostroot === undefined
        && current.profiles.length === 0
        && current.config['limits.cpu'] !== '0-7'
        ? current
        : undefined;
    }, { what: 'the full scan to revert the drift', timeoutMs: 180_000, intervalMs: 5_000 });
    assert.ok(reverted.config['limits.cpu']);
    assert.deepEqual((await fresh(alice, aliceOne)).cpuSet, expectedCpus);
    const audit = await h.api.get<AuditListResponse>('/audit', {
      action: 'container.drift_corrected',
      targetId: aliceOne.id,
      offset: 0,
    });
    assert.ok(audit.items.length >= 1, 'the correction is audited');
  });
});
