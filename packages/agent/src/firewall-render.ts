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
 * only chain sits on prerouting, the one bridge hook where `reject` works. It
 * sees every frame a guest sends on its `nyh*` veth, whether it goes to the
 * host itself, another guest on the bridge or the LAN beyond. Stateless: the
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
      ...document.rules.flatMap(renderFirewallRule),
    ]
    : [`iifname ${GUESTS} drop`];
  return [
    `table bridge ${AGENT_FIREWALL_TABLE}`,
    `delete table bridge ${AGENT_FIREWALL_TABLE}`,
    `table bridge ${AGENT_FIREWALL_TABLE} {`,
    `  comment "${firewallComment(owner, document?.digest ?? FAIL_CLOSED_KEY)}"`,
    '  chain egress {',
    '    type filter hook prerouting priority -190; policy accept;',
    ...body.map((line) => `    ${line}`),
    '  }',
    '}',
    '',
  ].join('\n');
}
