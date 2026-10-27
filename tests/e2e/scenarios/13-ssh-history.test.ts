// SSH connection history: one multiplexed client connection to the proxy
// reaches two containers (on two servers when the lab has them), is refused
// a non-22 forward and a shell on the jump host, and the history records the
// connection, each channel with its own server and bytes, and the refusals.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import type {
  ContainerDto,
  CursorPaginatedResponse,
  SshClientConfigDto,
  SshSessionDetailDto,
  SshSessionDto,
  SshSessionStatsDto,
} from '@nyabase/common';
import { writeFileSync } from 'node:fs';
import { Harness, type TestUser } from '../client/harness.js';
import { pollUntil } from '../client/poll.js';

const execFileAsync = promisify(execFile);

describe('SSH connection history', () => {
  let h: Harness;
  let user: TestUser;
  let stranger: TestUser;
  let containers: ContainerDto[];

  before(async () => {
    h = await Harness.start();
    user = await h.newUser('sshhist');
    stranger = await h.newUser('sshother');
    await h.addSshKey(user);
    const servers = h.state.servers.length > 1 ? h.state.servers.slice(0, 2) : [h.server, h.server];
    for (const server of new Set(servers)) {
      await h.grantServer(user, server);
      await h.grantPool(user, server.poolId);
    }
    containers = [];
    for (const server of servers) containers.push(await h.createContainer(user, server));
  });
  after(async () => h?.cleanup());

  it('records one connection with a channel per container, refused requests and bytes', async () => {
    const client = await user.session.api.get<SshClientConfigDto>(`/users/${user.id}/ssh-client-config`);
    const line = client.lines[0];
    assert.ok(line && client.knownHosts);
    const config = join(h.dir, 'history.conf');
    const knownHosts = join(h.dir, 'history-known-hosts');
    writeFileSync(knownHosts, `${client.knownHosts}\n`);
    writeFileSync(config, [
      'Host jump',
      `  HostName ${line.host}`,
      `  Port ${line.port}`,
      `  User ${user.username}`,
      `  HostKeyAlias ${line.port === 22 ? line.host : `[${line.host}]:${line.port}`}`,
      'Host *',
      `  IdentityFile ${user.keyFile}`,
      '  IdentitiesOnly yes',
      '  BatchMode yes',
      `  UserKnownHostsFile ${knownHosts}`,
      '  StrictHostKeyChecking yes',
      '  LogLevel ERROR',
      '  ConnectTimeout 20',
    ].join('\n'));
    const socket = join(h.dir, 'history.sock');
    const ssh = (args: string[]) => execFileAsync('ssh', ['-F', config, ...args], { timeout: 60_000 });
    // One master connection to the proxy; everything below rides on it.
    await ssh(['-M', '-S', socket, '-o', 'ControlPersist=120', '-f', '-N', 'jump']);
    h.defer('close ssh master', () => ssh(['-S', socket, '-O', 'exit', 'jump']).catch(() => undefined));
    for (const container of containers) {
      const { stdout } = await ssh([
        '-o', `ProxyCommand=ssh -F ${config} -S ${socket} -W %h:%p jump`,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        `${container.ssh.loginUser}@${container.ssh.hostName}`,
        'head -c 200000 /dev/zero',
      ]);
      assert.equal(stdout.length, 200_000);
    }
    // Refused on the jump host itself: a forward to port 80 and a shell.
    await assert.rejects(ssh(['-S', socket, '-W', `${containers[0]!.ssh.hostName}:80`, 'jump']));
    await assert.rejects(ssh(['-S', socket, 'jump', 'true']));
    await ssh(['-S', socket, '-O', 'exit', 'jump']);

    const session = await pollUntil(async () => {
      const page = await user.session.api.get<CursorPaginatedResponse<SshSessionDto>>('/ssh-sessions?state=closed');
      return page.items.find((item) => item.channelsOpened >= containers.length);
    }, { timeoutMs: 60_000, what: 'the closed SSH connection in the history' });
    assert.equal(session.username, user.username);
    assert.match(session.clientVersion ?? '', /^SSH-2\.0-OpenSSH/);
    assert.match(session.keyFingerprint, /^SHA256:/);
    assert.ok(session.bytesToClient > 2 * 200_000, `bytesToClient ${session.bytesToClient}`);
    assert.deepEqual(
      new Set(session.targets.map((target) => target.containerId)),
      new Set(containers.map((container) => container.id)),
    );
    assert.equal(session.rejectedRequests.rejected_permit, 1);
    assert.ok((session.rejectedRequests.session ?? 0) >= 1);

    const detail = await user.session.api.get<SshSessionDetailDto>(`/ssh-sessions/${session.id}`);
    const opened = detail.channels.filter((channel) => channel.result === 'opened');
    assert.equal(opened.length, containers.length);
    for (const [index, channel] of opened.entries()) {
      assert.equal(channel.route?.containerId, containers[index]!.id);
      assert.equal(channel.route?.serverId, containers[index]!.serverId);
      assert.ok(channel.bytesToClient > 200_000, `channel ${channel.seq} bytes ${channel.bytesToClient}`);
      assert.ok(channel.closedAt);
    }
    const refused = detail.channels.find((channel) => channel.result === 'rejected_permit');
    assert.equal(refused?.targetPort, 80);

    // The container filter finds it from either container; strangers do not.
    const byContainer = await user.session.api.get<CursorPaginatedResponse<SshSessionDto>>(
      `/ssh-sessions?containerId=${containers.at(-1)!.id}`,
    );
    assert.ok(byContainer.items.some((item) => item.id === session.id));
    assert.equal(await stranger.session.api.status('GET', `/ssh-sessions/${session.id}`), 404);
    assert.equal(await stranger.session.api.status('GET', '/ssh-sessions?scope=all'), 403);
    const all = await h.api.get<CursorPaginatedResponse<SshSessionDto>>(`/ssh-sessions?scope=all&peerIp=${session.peerIp}`);
    assert.ok(all.items.some((item) => item.id === session.id));

    const stats = await user.session.api.get<SshSessionStatsDto>('/ssh-sessions/stats?days=1');
    assert.ok(stats.totals.connections >= 1);
    assert.ok(stats.totals.channels >= containers.length);
    assert.equal(stats.topContainers.length, new Set(containers.map((container) => container.id)).size);
  });
});
