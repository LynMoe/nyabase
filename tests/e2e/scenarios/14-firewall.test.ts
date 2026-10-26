// The guest egress firewall: guests on one host reach each other by default;
// rules associated with the server are enforced on what guests send, first
// match by priority, drop / reject / accept, tcp / udp ports or all; the
// agent puts the table back after it is deleted and restores it from its
// persisted document (the unit's ExecStartPre `guest-guards`).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type {
  ContainerDto,
  CreateFirewallRuleRequest,
  FirewallRuleDto,
  FirewallServerStatusDto,
} from '@nyabase/common';
import { GIB, Harness, type TestUser } from '../client/harness.js';
import { pollUntil } from '../client/poll.js';

const TCP_OPEN = 18080;
const TCP_OTHER = 18081;
const UDP_PORT = 18082;

/** Exit status of a TCP connect from the guest: 0 open, 1 refused (reset), 124 timed out (dropped). */
const TCP_PROBE = (ip: string, port: number) =>
  `timeout 4 bash -c 'exec 3<>/dev/tcp/${ip}/${port}' 2>/dev/null; echo $?`;
/** "ok" when the UDP echo answered within 3 s. */
const UDP_PROBE = (ip: string, port: number) => `python3 - <<'EOF'
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(3)
try:
    s.sendto(b"ping", ("${ip}", ${port}))
    print("ok" if s.recvfrom(64)[0] == b"ping" else "bad")
except Exception:
    print("none")
EOF`;
const LISTENERS = `
nohup python3 -m http.server ${TCP_OPEN} </dev/null >/dev/null 2>&1 &
nohup python3 -m http.server ${TCP_OTHER} </dev/null >/dev/null 2>&1 &
nohup python3 -c '
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("0.0.0.0", ${UDP_PORT}))
while True:
    data, peer = s.recvfrom(64)
    s.sendto(data, peer)
' </dev/null >/dev/null 2>&1 &
sleep 1`;

describe('guest egress firewall', () => {
  let h: Harness;
  let user: TestUser;
  let client: ContainerDto;
  let target: ContainerDto;
  const rules: string[] = [];

  const guest = async (container: ContainerDto, command: string): Promise<string> =>
    (await h.incus(h.server, ['exec', container.instanceName!, '--', 'bash', '-c', command])).trim();
  const tcp = (port: number) => guest(client, TCP_PROBE(target.routedIp!, port));
  const udp = () => guest(client, UDP_PROBE(target.routedIp!, UDP_PORT));
  const status = async (): Promise<FirewallServerStatusDto> => {
    const all = await h.api.get<FirewallServerStatusDto[]>('/admin/firewall-rules/status');
    const mine = all.find((entry) => entry.serverId === h.server.id);
    assert.ok(mine, 'the status lists the run\'s server');
    return mine;
  };
  /** Waits until the agent confirmed exactly what the server should enforce now. */
  const synced = (what: string) => pollUntil(async () => {
    const current = await status();
    return current.state === 'synced' && current.appliedDigest === current.desiredDigest ? current : undefined;
  }, { what: `the firewall to sync (${what})`, timeoutMs: 60_000, intervalMs: 1_000 });
  const createRule = async (input: Omit<CreateFirewallRuleRequest, 'description' | 'serverIds' | 'ports'> & {
    ports?: CreateFirewallRuleRequest['ports'];
  }): Promise<FirewallRuleDto> => {
    const rule = await h.api.post<FirewallRuleDto>('/admin/firewall-rules', {
      ...input,
      name: h.name(input.name),
      serverIds: [h.server.id],
    });
    rules.push(rule.id);
    return rule;
  };
  const deleteRule = async (id: string): Promise<void> => {
    await h.api.delete(`/admin/firewall-rules/${id}`);
    rules.splice(rules.indexOf(id), 1);
  };
  /** Priorities are global; keep the run's rules in a band no other scenario uses. */
  const priority = (offset: number) => 900_000 + (Number.parseInt(h.state.runId.slice(-4), 16) % 9_000) * 10 + offset;

  before(async () => {
    h = await Harness.start();
    user = await h.newUser('fw');
    await h.grantServer(user, h.server, { cpuCores: 2, memBytes: 2 * GIB });
    client = await h.createContainer(user, h.server);
    target = await h.createContainer(user, h.server);
    h.defer('delete firewall rules', async () => {
      for (const id of [...rules]) await h.api.delete(`/admin/firewall-rules/${id}`).catch(() => undefined);
    });
    await guest(target, LISTENERS);
  });
  after(async () => h?.cleanup());

  it('lets guests on the same host reach each other without rules', async () => {
    const eth0 = JSON.parse(await h.incus(h.server, ['query', `/1.0/instances/${client.instanceName}`])) as {
      devices: Record<string, Record<string, string>>;
    };
    assert.equal(eth0.devices.eth0!['security.port_isolation'], undefined, 'guest NICs are not port-isolated');
    await synced('no rules');
    assert.equal(await tcp(TCP_OPEN), '0');
    assert.equal(await udp(), 'ok');
  });

  it('drops, then rejects, a TCP port and leaves other ports alone', async () => {
    const rule = await createRule({
      name: 'drop-tcp',
      priority: priority(5),
      action: 'drop',
      protocol: 'tcp',
      ports: [{ from: TCP_OPEN, to: TCP_OPEN }],
      cidrs: [target.routedIp!],
    });
    await synced('drop tcp');
    assert.equal(await tcp(TCP_OPEN), '124', 'dropped: the connect times out');
    assert.equal(await tcp(TCP_OTHER), '0', 'another port is not matched');
    assert.equal(await udp(), 'ok', 'udp is not matched');
    await h.api.patch(`/admin/firewall-rules/${rule.id}`, { expectedRevision: rule.revision, action: 'reject' });
    await synced('reject tcp');
    assert.equal(await tcp(TCP_OPEN), '1', 'rejected: the connect is refused at once');
    await deleteRule(rule.id);
    await synced('rule removed');
    assert.equal(await tcp(TCP_OPEN), '0');
  });

  it('drops UDP to a port without touching TCP', async () => {
    const rule = await createRule({
      name: 'drop-udp',
      priority: priority(6),
      action: 'drop',
      protocol: 'udp',
      ports: [{ from: UDP_PORT - 1, to: UDP_PORT + 1 }],
      cidrs: [target.routedIp!],
    });
    await synced('drop udp');
    assert.equal(await udp(), 'none');
    assert.equal(await tcp(TCP_OPEN), '0');
    await deleteRule(rule.id);
  });

  it('applies the first matching rule by priority', async () => {
    const wide = await createRule({
      name: 'drop-all',
      priority: priority(8),
      action: 'drop',
      protocol: 'all',
      cidrs: [`${target.routedIp!}/24`],
    });
    await createRule({
      name: 'allow-one',
      priority: priority(7),
      action: 'accept',
      protocol: 'tcp',
      ports: [{ from: TCP_OPEN, to: TCP_OPEN }],
      cidrs: [target.routedIp!],
    });
    await synced('accept before drop');
    assert.equal(await tcp(TCP_OPEN), '0', 'the earlier accept wins');
    assert.equal(await tcp(TCP_OTHER), '124', 'everything else in the range is dropped');
    assert.equal(await udp(), 'none');
    await h.api.patch(`/admin/firewall-rules/${wide.id}`, { expectedRevision: wide.revision, priority: priority(4) });
    await synced('drop before accept');
    assert.equal(await tcp(TCP_OPEN), '124', 'the drop now comes first');
  });

  it('puts the table back when it is deleted and restores it at boot from the persisted document', async () => {
    const { desiredDigest } = await synced('before tampering');
    const table = () => h.onHost(h.server, 'nft list table bridge nyabase_firewall 2>/dev/null || true');
    assert.match(await table(), new RegExp(`digest=${desiredDigest}`));
    await h.onHost(h.server, 'nft delete table bridge nyabase_firewall');
    await pollUntil(async () => ((await table()).includes(desiredDigest) ? true : undefined), {
      what: 'the agent to re-apply the deleted table', timeoutMs: 30_000, intervalMs: 500,
    });
    assert.equal(await tcp(TCP_OTHER), '124', 'the rules are back');

    const unit = `nyabase-e2e-agent-${h.state.runId}-s${h.server.index}`;
    await h.onHost(h.server, `nft delete table bridge nyabase_firewall && cd /var/tmp/${unit}/agent \
      && NYABASE_AGENT_STATE_DIR=/var/tmp/${unit}/state node dist/main.js guest-guards`);
    assert.match(await table(), new RegExp(`digest=${desiredDigest}`), 'guest-guards restored the persisted rules');
  });

  it('opens up again once the rules are gone', async () => {
    for (const id of [...rules]) await deleteRule(id);
    await synced('all rules removed');
    assert.equal(await tcp(TCP_OPEN), '0');
    assert.equal(await tcp(TCP_OTHER), '0');
    assert.equal(await udp(), 'ok');
  });
});
