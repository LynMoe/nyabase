// Full container lifecycle on one server, with SSH through the ssh-proxy.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ContainerPhase,
  ContainerStatus,
  type ContainerDto,
  type ExecSessionResponse,
  type IntentAcceptedDto,
  type SshClientConfigDto,
  type SshPublicKeyDto,
} from '@nyabase/common';
import { ApiError } from '../client/api.js';
import { GIB, Harness, type TestUser } from '../client/harness.js';
import { pollUntil, waitIntent } from '../client/poll.js';

describe('container lifecycle and SSH through the ssh-proxy', () => {
  let h: Harness;
  let owner: TestUser;
  let stranger: TestUser;
  let container: ContainerDto;
  let strangerContainer: ContainerDto;

  before(async () => {
    h = await Harness.start();
    owner = await h.newUser('owner');
    stranger = await h.newUser('stranger');
    await h.addSshKey(owner);
    await h.addSshKey(stranger);
    await h.grantServer(owner, h.server);
    container = await h.createContainer(owner, h.server);
    // The stranger has a reachable container of the same name (other case),
    // so name routing is exercised past key authentication.
    await h.grantServer(stranger, h.server);
    strangerContainer = await h.createContainer(stranger, h.server, { name: container.name.toUpperCase() });
  });
  after(async () => h?.cleanup());

  it('creates a running container with a routed IP and ready SSH', async () => {
    assert.equal(container.lifecyclePhase, ContainerPhase.Active);
    assert.equal(container.actual.status, ContainerStatus.Running);
    assert.match(container.routedIp ?? '', /^\d+\.\d+\.\d+\.\d+$/);
    assert.equal(container.ownerId, owner.id);
    assert.equal(container.serverId, h.server.id);
    assert.equal(container.ssh.enabled, true);
    assert.equal(container.ssh.ready, true);
    const mine = await owner.session.api.get<ContainerDto[]>('/containers');
    assert.ok(mine.some((entry) => entry.id === container.id));
    assert.equal(await owner.session.api.status('GET', '/containers?scope=all'), 403);
  });

  it('logs in by name with a host certificate, by IP, and refuses everyone else', async () => {
    // Strict host key checking against only the profile's known_hosts lines:
    // the guest is trusted through the owner's host CA, never on first use.
    const out = await h.ssh(owner, container, 'echo nyabase-e2e-ok; id -un');
    assert.match(out, /nyabase-e2e-ok/);
    assert.match(out, new RegExp(container.ssh.loginUser));
    assert.equal(container.ssh.hostName, `${container.name.toLowerCase()}.${(await clientConfig(owner)).hostSuffix}`);
    assert.match(
      await h.ssh(owner, container, 'cat /etc/ssh/ssh_host_ed25519_key-cert.pub'),
      /^ssh-ed25519-cert-v01@openssh\.com /,
    );
    assert.match(
      await h.ssh(owner, container, 'echo by-ip', { target: container.routedIp!, strictHostKeys: false }),
      /by-ip/,
    );
    // Names resolve among the key holder's own containers only: the same name
    // takes the stranger to their own container, even with the owner's jump login.
    const ownHost = (await h.ssh(owner, container, 'hostname')).trim();
    assert.equal(ownHost, container.instanceName);
    for (const jumpLogin of [undefined, `${owner.username}.${container.name}`]) {
      const landed = (await h.ssh(stranger, container, 'hostname', { jumpLogin })).trim();
      assert.equal(landed, strangerContainer.instanceName);
    }
    // The owner's address is refused to anyone else's key.
    await assert.rejects(h.ssh(stranger, container, 'true', { target: container.routedIp!, strictHostKeys: false }));
    // Another user's host CA does not vouch for this container.
    await assert.rejects(h.ssh(owner, container, 'true', { knownHostsFrom: stranger }));
  });

  it('syncs platform keys inside a managed block and keeps the lines the user added', async () => {
    const path = container.ssh.loginUser === 'root' ? '/root/.ssh/authorized_keys' : '.ssh/authorized_keys';
    const extra = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user-added';
    await h.ssh(owner, container, `echo '${extra}' >> ${path}`);
    const first = owner.keyFile!;
    await h.addSshKey(owner);
    // The new key reaches the guest by a sync; until then only the jump hop accepts it.
    await pollUntil(async () => {
      try {
        return await h.ssh(owner, container, `cat ${path}`);
      } catch {
        return undefined;
      }
    }, { timeoutMs: 180_000, what: 'the second key to reach the guest' });
    const file = await h.ssh(owner, container, `cat ${path}`);
    assert.ok(file.includes(extra), 'the user-added line survives the sync');
    assert.match(file, /# >>> nyabase: platform SSH keys/);
    const keys = await owner.session.api.get<SshPublicKeyDto[]>(`/users/${owner.id}/ssh-keys`);
    assert.equal(keys.length, 2);
    for (const key of keys) assert.ok(file.includes(key.keyText.split(' ')[1]!), 'every platform key is in the block');
    owner.keyFile = first;
  });

  it('changes the memory limit, keeps the CPU pinning, and grows the root disk', async () => {
    const api = owner.session.api;
    await waitIntent(api, await api.patch<IntentAcceptedDto>(`/containers/${container.id}/limits`, {
      memBytes: 2 * GIB,
    }));
    const limited = await api.get<ContainerDto>(`/containers/${container.id}`);
    assert.equal(limited.memBytes, 2 * GIB);
    assert.equal(limited.cpuSet?.length, 2, 'pinned to the owner\'s two granted cores');
    assert.equal(
      await api.status('PATCH', `/containers/${container.id}/limits`, { cpuMillis: 1000, memBytes: GIB }),
      400,
      'CPU is no longer sized per container',
    );

    const grown = container.rootSizeBytes + GIB;
    await waitIntent(api, await api.patch<IntentAcceptedDto>(`/containers/${container.id}/root-size`, {
      sizeBytes: grown,
    }));
    await h.waitContainer(api, container.id, (c) => c.rootSizeBytes === grown && c.rootSizePendingBytes === null,
      'the root disk to grow');
  });

  it('stops, starts and restarts; SSH follows the power state', async () => {
    const api = owner.session.api;
    const stopped = await h.power(api, container.id, 'stop');
    assert.equal(stopped.actual.status, ContainerStatus.Stopped);
    await assert.rejects(h.ssh(owner, stopped, 'true'), 'no SSH into a stopped container');

    const started = await h.power(api, container.id, 'start', owner);
    assert.match(await h.ssh(owner, started, 'echo back-up'), /back-up/);

    const restarted = await h.power(api, container.id, 'restart', owner);
    assert.match(await h.ssh(owner, restarted, 'uptime -s; echo restarted'), /restarted/);
  });

  it('repairs SSH and opens a console session', async () => {
    const api = owner.session.api;
    // Repair wakes the SSH convergence; it is not an intent.
    const repaired = await api.post<{ woken: boolean }>(`/containers/${container.id}/actions/repair-ssh`);
    assert.equal(typeof repaired.woken, 'boolean');
    const stats = await api.get<unknown>(`/containers/${container.id}/stats`);
    assert.ok(stats && typeof stats === 'object');

    const session = await api.post<ExecSessionResponse>(`/containers/${container.id}/exec-sessions`, {});
    assert.ok(session.sessionId && session.consoleUrl && session.expiresAt);
  });

  it('rejects invalid creates before touching Incus', async () => {
    const api = owner.session.api;
    const base = {
      serverId: h.server.id,
      imageId: h.state.image.id,
      rootSizeBytes: h.state.rootSizeBytes,
      memBytes: GIB,
      powerIntent: 'stopped',
    };
    assert.equal(await api.status('POST', '/containers', { ...base, name: 'bad name!' }), 400);
    await assert.rejects(
      api.post('/containers', { ...base, name: container.name }),
      (error: unknown) => error instanceof ApiError && error.status === 409,
    );
    assert.equal(await api.status('POST', '/containers', { ...base, name: h.name('x'), memBytes: 0 }), 400);
    assert.equal(await api.status('POST', '/containers', { ...base, name: h.name('x'), memBytes: 64 * GIB, powerIntent: 'running' }), 403);
  });

  it('deletes the container and withdraws its SSH route', async () => {
    const api = owner.session.api;
    const last = await api.get<ContainerDto>(`/containers/${container.id}`);
    await h.deleteContainer(api, container.id);
    assert.equal(await api.status('GET', `/containers/${container.id}`), 404);
    assert.deepEqual(
      (await api.get<ContainerDto[]>('/containers')).filter((entry) => entry.id === container.id),
      [],
    );
    await pollUntil(async () => {
      try {
        await h.ssh(owner, last, 'true');
        return undefined;
      } catch {
        return true;
      }
    }, { what: 'the SSH route to be withdrawn', timeoutMs: 180_000, intervalMs: 5_000 });
  });
});

function clientConfig(user: TestUser): Promise<SshClientConfigDto> {
  return user.session.api.get<SshClientConfigDto>(`/users/${user.id}/ssh-client-config`);
}
