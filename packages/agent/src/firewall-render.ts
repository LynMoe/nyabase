import {
  AGENT_FIREWALL_TABLE,
  firewallAddressIntervals,
  FirewallAction,
  FirewallProtocol,
  MANAGED_NIC_HOST_NAME_PREFIX,
  type FirewallDocument,
  type FirewallRuleSpec,
} from '@nyabase/common';

/*
 * The guest egress firewall as nft sees it: one bridge-family table whose
 * filtering chain sits on prerouting, the one bridge hook where `reject` works
 * (the guards' MAC learning adds forward / output chains that never drop). It
 * sees every frame a guest sends on its `nyh*` veth, whether it goes to the
 * host itself, another guest on the bridge or the LAN beyond. Fixed L2 guards
 * (GUARD_RULES) come first; the Backend's rules after them are stateless: the
 * first rule that matches decides, and no match accepts (only this table: the
 * IPv6 guard and Incus's own filters still run after it).
 */

/** Who wrote the table: a server id (32 hex digits, no dashes) or `unknown` before enrollment. */
export type FirewallOwner = string;
export const UNKNOWN_FIREWALL_OWNER = 'unknown';
/** What the table enforces: a document digest, or this when the agent has none. */
export const FAIL_CLOSED_KEY = 'fail-closed';

/**
 * The table comment: the owner and the content, so a second agent on the
 * same host (which must not happen) shows up instead of silently fighting.
 * nft caps comments at 128 characters; this is at most 126.
 */
export function firewallComment(owner: FirewallOwner, key: string): string {
  return `nyabase egress server=${owner} digest=${key}`;
}

const COMMENT_PATTERN = /comment "nyabase egress server=([0-9a-f]{32}|unknown) digest=([0-9a-f]{64}|fail-closed)"/;

/** The owner and content a listed table claims, or null when it carries no nyabase comment. */
export function parseFirewallComment(listing: string): { owner: FirewallOwner; key: string } | null {
  const match = COMMENT_PATTERN.exec(listing);
  return match ? { owner: match[1]!, key: match[2]! } : null;
}

/** A server id as the table comment carries it. */
export function firewallOwnerOf(serverId: string | undefined): FirewallOwner {
  const hex = serverId?.replaceAll('-', '').toLowerCase();
  return hex && /^[0-9a-f]{32}$/.test(hex) ? hex : UNKNOWN_FIREWALL_OWNER;
}

const GUESTS = `"${MANAGED_NIC_HOST_NAME_PREFIX}*"`;

/** Per-NIC budget for ARP broadcasts (resolving neighbours needs a few per minute). */
export const ARP_BROADCAST_LIMIT = { perSecond: 20, burst: 100 } as const;
/** Per-NIC budget for unicast frames to a MAC that is not in `learned_macs`. */
export const UNLEARNED_DESTINATION_LIMIT = { perSecond: 20, burst: 200 } as const;
/** A MAC stays learned this long after it was learned or last sent ARP to a guest (a switch's usual ageing time). */
const LEARNED_MEMORY = '5m';
/** How long a NIC's budget is kept after the last frame that counted against it. */
const BUDGET_MEMORY = '1m';
/** Guest NICs on one host (budgets) and stations talking to its guests (learned MACs). */
const GUARD_SET_SIZE = 65_536;

const limitOver = ({ perSecond, burst }: { perSecond: number; burst: number }): string =>
  `limit rate over ${perSecond}/second burst ${burst} packets`;

function dynamicSet(name: string, key: string, timeout: string): string[] {
  return [`set ${name} {`, `  typeof ${key}`, `  size ${GUARD_SET_SIZE}`, '  flags dynamic,timeout', `  timeout ${timeout}`, '}'];
}

/*
 * Fixed guards ahead of the Backend's rules on every server, so no rule
 * accepts past them: what a guest could otherwise put on the whole L2 segment
 * at its full egress rate. Nothing a guest normally sends hits them.
 * - Broadcast carries ARP only, within a per-NIC budget; every other
 *   broadcast and all multicast are dropped (IPv4 multicast, STP / LLDP /
 *   LACP group addresses), and so is IPv4 multicast, limited broadcast and
 *   class E inside unicast frames.
 * - Guests have static addresses: no DHCP in any role (a server answering
 *   for other machines on the segment, a client, a relay).
 * - Unicast to a MAC no switch knows floods every port. A MAC is learned
 *   when it sends a frame to a guest here (the gateway, the host, LAN peers
 *   and other guests all answer the guest's ARP and its traffic), so frames
 *   to learned MACs pass unlimited and the rest share a per-NIC budget.
 *   Learning runs on forward / output after Incus's MAC filters (priority
 *   -200), so a guest cannot get a spoofed source MAC learned. A rewrite
 *   empties the sets; the next frame from each station relearns it.
 * The sets change with traffic, so the agent lists the table tersely (without
 * set elements) when it verifies it.
 */
const GUARD_SETS = [
  ...dynamicSet('arp_broadcast_budget', 'iifname', BUDGET_MEMORY),
  ...dynamicSet('unlearned_budget', 'iifname', BUDGET_MEMORY),
  ...dynamicSet('learned_macs', 'ether saddr', LEARNED_MEMORY),
];

const GUARD_RULES = [
  `ether daddr ff:ff:ff:ff:ff:ff ether type arp update @arp_broadcast_budget { iifname ${limitOver(ARP_BROADCAST_LIMIT)} } drop`,
  'ether daddr ff:ff:ff:ff:ff:ff ether type arp accept',
  'ether daddr & 01:00:00:00:00:00 == 01:00:00:00:00:00 drop',
  'ip daddr 224.0.0.0/3 drop',
  'meta l4proto udp udp dport { 67, 68 } drop',
  `ether daddr != @learned_macs update @unlearned_budget { iifname ${limitOver(UNLEARNED_DESTINATION_LIMIT)} } drop`,
];

// ARP (the guest's neighbour probes keep it coming every minute or so) refreshes
// a station; any other frame only adds a missing one, a read-only lookup on the
// hot path otherwise.
const LEARNING_CHAINS = (['forward', 'output'] as const).flatMap((hook) => [
  `chain learn_${hook} {`,
  `  type filter hook ${hook} priority 100; policy accept;`,
  `  oifname ${GUESTS} ether type arp update @learned_macs { ether saddr }`,
  `  oifname ${GUESTS} add @learned_macs { ether saddr }`,
  '}',
]);

function addressSet(cidrs: readonly string[]): string {
  const elements = firewallAddressIntervals(cidrs)
    .map(({ first, last }) => (first === last ? first : `${first}-${last}`));
  return `{ ${elements.join(', ')} }`;
}

/** The nft rules for one spec, in order: one, or two for reject on every protocol and for accept with ports. */
export function renderFirewallRule(rule: FirewallRuleSpec): string[] {
  const match = `ip daddr ${addressSet(rule.cidrs)}`;
  if (rule.protocol === FirewallProtocol.All) {
    if (rule.action !== FirewallAction.Reject) return [`${match} ${rule.action}`];
    // TCP gets a reset; everything else (UDP, ICMP, other protocols) an ICMP error.
    return [
      `${match} meta l4proto tcp reject with tcp reset`,
      `${match} reject with icmp type admin-prohibited`,
    ];
  }
  const protocol = rule.protocol;
  const ports = rule.ports.length === 0
    ? ''
    : ` ${protocol} dport { ${rule.ports.map(({ from, to }) => (from === to ? `${from}` : `${from}-${to}`)).join(', ')} }`;
  const verdict = rule.action !== FirewallAction.Reject
    ? rule.action
    : protocol === FirewallProtocol.Tcp
      ? 'reject with tcp reset'
      : 'reject with icmp type port-unreachable';
  const rendered = [`${match} meta l4proto ${protocol}${ports} ${verdict}`];
  // Non-first fragments carry no ports, so `dport` never matches them and they
  // would fall through to later rules: an accepted datagram larger than the
  // MTU would lose its tail to a broader drop below. Accepting every non-first
  // fragment of the protocol is safe: without its first fragment (which the
  // port match decides) a datagram is never reassembled.
  if (ports && rule.action === FirewallAction.Accept) {
    rendered.push(`${match} ip frag-off & 0x1fff != 0 meta l4proto ${protocol} accept`);
  }
  return rendered;
}

/**
 * The whole table for `document` (null: the fail-closed table, which drops
 * every frame guests send, ARP included, until a document arrives). One nft
 * transaction declares, deletes and recreates the table, so it is replaced
 * atomically and never seen empty.
 */
export function renderFirewallRuleset(owner: FirewallOwner, document: FirewallDocument | null): string {
  const body = document
    ? [
      `iifname != ${GUESTS} accept`,
      // VLAN / QinQ / PPPoE / MPLS / IPv6 would carry IPv4 past `ip daddr`: none of it leaves a guest.
      `iifname ${GUESTS} ether type != { ip, arp } drop`,
      ...GUARD_RULES,
      ...document.rules.flatMap(renderFirewallRule),
    ]
    : [`iifname ${GUESTS} drop`];
  return [
    `table bridge ${AGENT_FIREWALL_TABLE}`,
    `delete table bridge ${AGENT_FIREWALL_TABLE}`,
    `table bridge ${AGENT_FIREWALL_TABLE} {`,
    `  comment "${firewallComment(owner, document?.digest ?? FAIL_CLOSED_KEY)}"`,
    ...(document ? GUARD_SETS.map((line) => `  ${line}`) : []),
    '  chain egress {',
    '    type filter hook prerouting priority -190; policy accept;',
    ...body.map((line) => `    ${line}`),
    '  }',
    ...(document ? LEARNING_CHAINS.map((line) => `  ${line}`) : []),
    '}',
    '',
  ].join('\n');
}
