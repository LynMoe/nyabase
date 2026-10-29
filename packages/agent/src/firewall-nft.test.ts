import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  FIREWALL_MAX_CIDRS_PER_RULE,
  FIREWALL_MAX_PORT_RANGES_PER_RULE,
  FIREWALL_MAX_RULES_PER_SERVER,
  numToIp,
  zFirewallDocument,
  type FirewallDocument,
  type FirewallRuleSpec,
} from '@nyabase/common';
import {
  ARP_BROADCAST_LIMIT,
  UNLEARNED_DESTINATION_LIMIT,
  parseFirewallComment,
  renderFirewallRuleset,
} from './firewall-render.js';
import { renderIpv6GuardRuleset } from './ipv6-guard.js';

/*
 * The renderings against the real nft and kernel, each in a throwaway network
 * namespace (`unshare -n`), never the host's ruleset. Skipped where that is
 * not possible (no nft, not root).
 */
const scratch = mkdtempSync(join(tmpdir(), 'nyabase-agent-nft-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function isolatedNftWorks(): boolean {
  const probe = join(scratch, 'probe.nft');
  writeFileSync(probe, 'table bridge nyabase_probe\n');
  return spawnSync('unshare', ['-n', 'nft', '-f', probe], { stdio: 'ignore' }).status === 0;
}

/** Load `rulesets` one after the other into one fresh namespace; the terse listing (as the agent takes it) after each. */
function loadInNamespace(...rulesets: string[]): string[] {
  const files = rulesets.map((ruleset, index) => {
    const file = join(scratch, `ruleset-${index}.nft`);
    writeFileSync(file, ruleset);
    return file;
  });
  const script = files
    .map((file) => `nft -c -f '${file}' && nft -f '${file}' && nft -t list table bridge nyabase_firewall && echo '-----'`)
    .join(' && ');
  return execFileSync('unshare', ['-n', 'sh', '-ec', script], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('-----\n')
    .slice(0, rulesets.length);
}

const OWNER = '0123456789abcdef0123456789abcdef';

function largestDocument(): FirewallDocument {
  // The limits at once: 256 rules, 4081 of the 4096 CIDRs, 32 port ranges, every rule kind.
  const kinds: Array<Pick<FirewallRuleSpec, 'action' | 'protocol'>> = [
    { action: 'accept', protocol: 'tcp' },
    { action: 'reject', protocol: 'all' },
    { action: 'reject', protocol: 'udp' },
    { action: 'drop', protocol: 'all' },
  ];
  const rules: FirewallRuleSpec[] = [];
  for (let index = 0; index < FIREWALL_MAX_RULES_PER_SERVER; index += 1) {
    const kind = kinds[index % kinds.length]!;
    const cidrs = index < 15
      ? Array.from({ length: FIREWALL_MAX_CIDRS_PER_RULE }, (_, item) => `${numToIp(((10 << 24) >>> 0) + (index * FIREWALL_MAX_CIDRS_PER_RULE + item) * 4)}/31`)
      : [`${numToIp(((172 << 24) >>> 0) + index * 256)}/24`];
    const ports = kind.protocol === 'all'
      ? []
      : Array.from({ length: FIREWALL_MAX_PORT_RANGES_PER_RULE }, (_, item) => ({ from: 1000 + item * 10, to: 1000 + item * 10 + 4 }));
    rules.push({ ...kind, cidrs, ports });
  }
  return zFirewallDocument.parse({ digest: 'c'.repeat(64), rules });
}

describe.skipIf(!isolatedNftWorks())('firewall rulesets in real nft', () => {
  it('loads every rule kind, the empty document and the fail-closed table, and lists them stably', () => {
    const sample: FirewallDocument = {
      digest: 'a'.repeat(64),
      rules: [
        { action: 'accept', protocol: 'all', cidrs: ['10.0.0.0/9', '10.128.0.0/9', '192.168.1.5/32'], ports: [] },
        { action: 'accept', protocol: 'udp', cidrs: ['10.9.0.0/16'], ports: [{ from: 9999, to: 9999 }] },
        { action: 'reject', protocol: 'tcp', cidrs: ['10.0.0.0/8'], ports: [{ from: 22, to: 22 }, { from: 8000, to: 9000 }] },
        { action: 'reject', protocol: 'udp', cidrs: ['0.0.0.0/0'], ports: [{ from: 53, to: 53 }] },
        { action: 'reject', protocol: 'udp', cidrs: ['8.8.8.8/32'], ports: [] },
        { action: 'reject', protocol: 'all', cidrs: ['1.2.3.4/32'], ports: [] },
        { action: 'drop', protocol: 'udp', cidrs: ['1.2.3.0/24'], ports: [] },
        { action: 'drop', protocol: 'tcp', cidrs: ['1.2.4.0/24'], ports: [{ from: 1, to: 65535 }] },
        { action: 'drop', protocol: 'all', cidrs: ['1.2.3.0/25', '1.2.3.128/25'], ports: [] },
      ],
    };
    const rendered = renderFirewallRuleset(OWNER, sample);
    const [first, again, empty, closed] = loadInNamespace(
      rendered,
      rendered,
      renderFirewallRuleset(OWNER, { digest: 'b'.repeat(64), rules: [] }),
      renderFirewallRuleset('unknown', null),
    );
    expect(again).toBe(first);
    expect(parseFirewallComment(first!)).toEqual({ owner: OWNER, key: 'a'.repeat(64) });
    expect(first).toContain('hook prerouting');
    expect(first).toContain('reject with tcp reset');
    expect(first).toContain('reject with icmp admin-prohibited');
    expect(first).toMatch(/frag-off & 0x1fff != 0x0 meta l4proto udp accept/);
    expect(empty).toContain('ether type != { ip, arp } drop');
    expect(empty).toContain('udp dport { 67, 68 } drop');
    expect(empty).toContain('oifname "nyh*" ether type arp update @learned_macs { ether saddr }');
    expect(empty).toContain('oifname "nyh*" add @learned_macs { ether saddr }');
    expect(parseFirewallComment(closed!)).toEqual({ owner: 'unknown', key: 'fail-closed' });
    expect(closed).toContain('iifname "nyh*" drop');
  });

  it('loads the largest document the limits allow, next to the IPv6 guard', () => {
    const guard = join(scratch, 'guard.nft');
    writeFileSync(guard, renderIpv6GuardRuleset());
    const file = join(scratch, 'largest.nft');
    writeFileSync(file, renderFirewallRuleset(OWNER, largestDocument()));
    const listing = execFileSync('unshare', ['-n', 'sh', '-ec', `nft -f '${guard}' && nft -f '${file}' && nft -t list table bridge nyabase_firewall`], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(parseFirewallComment(listing)).toEqual({ owner: OWNER, key: 'c'.repeat(64) });
    // Well under the 4 MiB the agent allows a listing.
    expect(Buffer.byteLength(listing)).toBeLessThan(4 * 1024 * 1024);
  });

  it.skipIf(!pythonWorks())('lets ordinary guest frames through the fixed guards and stops broadcast, multicast, DHCP and unknown-unicast floods', () => {
    const file = join(scratch, 'guards.nft');
    writeFileSync(file, renderFirewallRuleset(OWNER, { digest: 'd'.repeat(64), rules: [] }));
    const sender = join(scratch, 'guest-frames.py');
    writeFileSync(sender, GUEST_FRAMES_PY);
    // A guest veth (`nyh…` on the bridge, `g0` its guest end) and an observer port (`o0`) on one bridge.
    const output = execFileSync('unshare', ['-n', 'sh', '-ec', [
      'ip link add br0 type bridge && ip link set br0 up',
      'ip link add nyh000000000001 type veth peer name g0 && ip link add obr type veth peer name o0',
      'for port in nyh000000000001 obr; do ip link set $port master br0 && ip link set $port up; done',
      'ip link set g0 up && ip link set o0 up',
      `nft -f '${file}'`,
      'nft -t list table bridge nyabase_firewall > before.nft',
      `python3 -I '${sender}'`,
      'nft -t list table bridge nyabase_firewall | cmp -s before.nft - && echo "terse listing unchanged"',
      // The host answering a guest teaches the bridge's own MAC through the output hook.
      'ip addr add 10.0.0.1/24 dev br0 && ip neigh replace 10.0.0.2 lladdr 02:6e:0a:00:00:02 dev br0',
      'ping -c 1 -W 1 10.0.0.2 > /dev/null || true',
      'nft list set bridge nyabase_firewall learned_macs > learned.txt',
      'grep -q "$(ip -br link show br0 | awk \'{ print $3 }\')" learned.txt && echo "host learned"',
      'grep -q "02:00:00:00:00:99" learned.txt && echo "peer learned"',
      'grep -q "02:00:00:00:00:77" learned.txt && echo "arp station learned"',
      'grep -q "02:aa:bb:cc:dd:ee" learned.txt || echo "flood target not learned"',
    ].join('\n')], { encoding: 'utf8', cwd: scratch });
    const received = Object.fromEntries(
      [...output.matchAll(/^(\S+) (\d+)$/gm)].map(([, name, count]) => [name!, Number(count)]),
    );
    expect(received['arp_broadcast']).toBeGreaterThanOrEqual(ARP_BROADCAST_LIMIT.burst);
    expect(received['arp_broadcast']).toBeLessThan(ARP_BROADCAST_LIMIT.burst + 100);
    for (const blocked of ['udp_broadcast', 'subnet_broadcast', 'mdns', 'stp_bpdu', 'lldp', 'multicast_in_unicast', 'dhcp_offer', 'dhcp_request', 'dhcp_relay']) {
      expect({ [blocked]: received[blocked] }).toEqual({ [blocked]: 0 });
    }
    // A flood to one MAC nothing has sent from gets the budget, and then the refill only.
    expect(received['one_unlearned_destination']).toBeGreaterThanOrEqual(UNLEARNED_DESTINATION_LIMIT.burst);
    expect(received['one_unlearned_destination']).toBeLessThan(UNLEARNED_DESTINATION_LIMIT.burst + 100);
    expect(received['random_destinations']).toBeLessThan(100);
    // Once the peer has sent a frame to the guest, traffic to it is unlimited, budget or not.
    expect(received['learned_destination']).toBe(2000);
    expect(received['unicast_arp']).toBe(5);
    expect(received['tcp_to_learned']).toBe(5);
    expect(output).toContain('terse listing unchanged');
    expect(output).toContain('host learned');
    expect(output).toContain('peer learned');
    expect(output).toContain('arp station learned');
    expect(output).toContain('flood target not learned');
  }, 30_000);
});

function pythonWorks(): boolean {
  return isolatedNftWorks() && spawnSync('python3', ['-I', '-c', 'import socket; socket.AF_PACKET'], { stdio: 'ignore' }).status === 0;
}

/** Sends each kind of frame from `g0` and prints how many of each reached `o0`. */
const GUEST_FRAMES_PY = String.raw`
import os, socket, struct
mac = lambda text: bytes.fromhex(text.replace(':', ''))
GUEST, PEER, BROADCAST = mac('02:6e:0a:00:00:02'), mac('02:00:00:00:00:99'), b'\xff' * 6
def eth(dst, ethertype): return dst + GUEST + struct.pack('!H', ethertype)
def ipv4(dst, proto=17, sport=1234, dport=9999):
    l4 = struct.pack('!HHHH', sport, dport, 8, 0) if proto == 17 else struct.pack('!HHIIBBHHH', sport, dport, 1, 0, 0x50, 2, 1024, 0, 0)
    return struct.pack('!BBHHHBBH4s4s', 0x45, 0, 20 + len(l4), 0, 0, 64, proto, 0, socket.inet_aton('10.0.0.2'), socket.inet_aton(dst)) + l4
def arp(target): return struct.pack('!HHBBH6s4s6s4s', 1, 0x0800, 6, 4, 1, GUEST, socket.inet_aton('10.0.0.2'), bytes(6), socket.inet_aton(target))
tx = socket.socket(socket.AF_PACKET, socket.SOCK_RAW); tx.bind(('g0', 0))
rx = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3))
rx.setsockopt(socket.SOL_SOCKET, 33, 64 << 20)  # SO_RCVBUFFORCE: hold every frame of a burst
rx.bind(('o0', 0)); rx.settimeout(0.3)
uplink = socket.socket(socket.AF_PACKET, socket.SOCK_RAW); uplink.bind(('o0', 0))
def received():
    count = 0
    while True:
        try: frame = rx.recv(65535)
        except socket.timeout: return count
        count += frame[6:12] == GUEST
def send(name, frames):
    received()
    for frame in frames: tx.send(frame)
    print(name, received())
send('arp_broadcast', [eth(BROADCAST, 0x0806) + arp('10.0.0.1')] * 300)
send('udp_broadcast', [eth(BROADCAST, 0x0800) + ipv4('255.255.255.255')] * 5)
send('subnet_broadcast', [eth(BROADCAST, 0x0800) + ipv4('10.0.0.255')] * 5)
send('mdns', [eth(mac('01:00:5e:00:00:fb'), 0x0800) + ipv4('224.0.0.251', dport=5353)] * 5)
send('stp_bpdu', [mac('01:80:c2:00:00:00') + GUEST + struct.pack('!H', 38) + b'\x42\x42\x03' + bytes(35)] * 5)
send('lldp', [eth(mac('01:80:c2:00:00:0e'), 0x88cc) + bytes(46)] * 5)
send('multicast_in_unicast', [eth(PEER, 0x0800) + ipv4('239.1.1.1')] * 5)
send('dhcp_offer', [eth(PEER, 0x0800) + ipv4('10.0.0.50', sport=67, dport=68)] * 5)
send('dhcp_request', [eth(PEER, 0x0800) + ipv4('10.0.0.1', sport=68, dport=67)] * 5)
send('dhcp_relay', [eth(PEER, 0x0800) + ipv4('10.0.0.1', sport=67, dport=67)] * 5)
send('one_unlearned_destination', [eth(mac('02:aa:bb:cc:dd:ee'), 0x0800) + ipv4('10.0.0.9')] * 1000)
send('random_destinations', [eth(b'\x02' + os.urandom(5), 0x0800) + ipv4('10.0.0.9') for _ in range(100)])
uplink.send(GUEST + PEER + struct.pack('!H', 0x0800) + ipv4('10.0.0.2'))  # the peer answers the guest
uplink.send(GUEST + mac('02:00:00:00:00:77') + struct.pack('!H', 0x0806) + bytes(28))  # an ARP from another station
send('learned_destination', [eth(PEER, 0x0800) + ipv4('10.0.0.9')] * 2000)
send('unicast_arp', [eth(PEER, 0x0806) + arp('10.0.0.9')] * 5)
send('tcp_to_learned', [eth(PEER, 0x0800) + ipv4('10.0.0.9', proto=6, dport=22)] * 5)
`;
