import { z } from 'zod';
import { canonicalIpv4Cidr, canonicalJson, ipToNum, numToIp, parseCidr } from '../utils.js';

/*
 * Guest egress firewall. Rules are admin-owned entries associated with
 * servers; on each server the agent keeps them, ordered by priority, in the
 * nft table `bridge nyabase_firewall` (AGENT_FIREWALL_TABLE). Only packets
 * guests send (ingress on their `nyh*` host-side veth) are matched, statelessly:
 * the first rule that matches decides, and no match means accept.
 */

export const FirewallAction = {
  Accept: 'accept',
  Drop: 'drop',
  Reject: 'reject',
} as const;
export type FirewallAction = typeof FirewallAction[keyof typeof FirewallAction];

export const FirewallProtocol = {
  All: 'all',
  Tcp: 'tcp',
  Udp: 'udp',
} as const;
export type FirewallProtocol = typeof FirewallProtocol[keyof typeof FirewallProtocol];

export const FIREWALL_PRIORITY_MIN = 1;
export const FIREWALL_PRIORITY_MAX = 1_000_000;
export const FIREWALL_MAX_CIDRS_PER_RULE = 256;
export const FIREWALL_MAX_PORT_RANGES_PER_RULE = 32;
/** Per server, over every rule associated with it. */
export const FIREWALL_MAX_RULES_PER_SERVER = 256;
export const FIREWALL_MAX_CIDRS_PER_SERVER = 4_096;

export interface FirewallPortRange {
  from: number;
  to: number;
}

/** What the agent needs of one rule; the document lists them in priority order. */
export interface FirewallRuleSpec {
  action: FirewallAction;
  protocol: FirewallProtocol;
  /** Canonical IPv4 CIDRs (network-aligned, a single address is /32), sorted and unique. */
  cidrs: string[];
  /** tcp / udp only, sorted and merged; empty = every port. Always empty for `all`. */
  ports: FirewallPortRange[];
}

/** The rules of one server, as the Backend sends them in `firewall.apply`. */
export interface FirewallDocument {
  /** sha256 hex of `firewallDigestInput(rules)`; an identity the agent reports back, not re-derived. */
  digest: string;
  rules: FirewallRuleSpec[];
}

function cidrRange(cidr: string): [number, number] {
  const { base, prefixLen } = parseCidr(cidr);
  const size = 2 ** (32 - prefixLen);
  const start = ipToNum(base) - (ipToNum(base) % size);
  return [start, start + size - 1];
}

/** A CIDR or a bare IPv4 address (as /32) in canonical form; throws when it is neither. */
export function canonicalFirewallCidr(value: string): string {
  const trimmed = value.trim();
  return canonicalIpv4Cidr(trimmed.includes('/') ? trimmed : `${trimmed}/32`);
}

/** Canonical, unique, sorted by network address then prefix length. */
export function canonicalFirewallCidrs(values: readonly string[]): string[] {
  const unique = [...new Set(values.map(canonicalFirewallCidr))];
  return unique.sort((left, right) => {
    const [leftStart] = cidrRange(left);
    const [rightStart] = cidrRange(right);
    return leftStart - rightStart || parseCidr(left).prefixLen - parseCidr(right).prefixLen;
  });
}

/** Sorted, with overlapping and adjacent ranges merged. */
export function canonicalFirewallPorts(ranges: readonly FirewallPortRange[]): FirewallPortRange[] {
  const sorted = [...ranges].sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: FirewallPortRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
    else merged.push({ from: range.from, to: range.to });
  }
  return merged;
}

/** Disjoint, sorted inclusive address intervals covering `cidrs` (what nft gets as set elements). */
export function firewallAddressIntervals(cidrs: readonly string[]): Array<{ first: string; last: string }> {
  const ranges = cidrs.map(cidrRange).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged.map(([start, end]) => ({ first: numToIp(start), last: numToIp(end) }));
}

/** "22, 80, 8000-9000" → ranges; throws with a readable message on bad input. */
export function parseFirewallPorts(text: string): FirewallPortRange[] {
  const items = text.split(/[\s,，]+/).filter((item) => item.length > 0);
  return items.map((item) => {
    const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(item);
    if (!match) throw new Error(`无效的端口：${item}`);
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || to > 65_535 || from > to) throw new Error(`无效的端口：${item}`);
    return { from, to };
  });
}

export function formatFirewallPorts(ranges: readonly FirewallPortRange[]): string {
  return ranges.map((range) => (range.from === range.to ? String(range.from) : `${range.from}-${range.to}`)).join(', ');
}

/** The exact bytes the document digest is the sha256 of. */
export function firewallDigestInput(rules: readonly FirewallRuleSpec[]): string {
  return canonicalJson(rules.map((rule) => ({
    action: rule.action,
    protocol: rule.protocol,
    cidrs: rule.cidrs,
    ports: rule.ports.map((range) => ({ from: range.from, to: range.to })),
  })));
}

export const zFirewallAction = z.enum([FirewallAction.Accept, FirewallAction.Drop, FirewallAction.Reject]);
export const zFirewallProtocol = z.enum([FirewallProtocol.All, FirewallProtocol.Tcp, FirewallProtocol.Udp]);
export const zFirewallPortRange = z.object({
  from: z.number().int().min(1).max(65_535),
  to: z.number().int().min(1).max(65_535),
}).strict().refine((range) => range.from <= range.to, 'from must not exceed to');

/** A CIDR or bare address, normalized to canonical CIDR. */
export const zFirewallCidr = z.string().max(64).superRefine((value, context) => {
  try {
    canonicalFirewallCidr(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected an IPv4 address or CIDR' });
  }
}).transform(canonicalFirewallCidr);

/** Request-side lists: normalized, then bounded. */
export const zFirewallCidrList = z.array(zFirewallCidr)
  .min(1)
  .max(FIREWALL_MAX_CIDRS_PER_RULE)
  .transform((values) => canonicalFirewallCidrs(values));
export const zFirewallPortList = z.array(zFirewallPortRange)
  .max(FIREWALL_MAX_PORT_RANGES_PER_RULE)
  .transform((ranges) => canonicalFirewallPorts(ranges));

const isCanonicalCidr = (value: string): boolean => {
  try {
    return canonicalFirewallCidr(value) === value && value.includes('/');
  } catch {
    return false;
  }
};

/** Agent-side: a rule exactly as the Backend renders it (already canonical). */
export const zFirewallRuleSpec = z.object({
  action: zFirewallAction,
  protocol: zFirewallProtocol,
  cidrs: z.array(z.string().max(18).refine(isCanonicalCidr, 'Expected a canonical IPv4 CIDR'))
    .min(1)
    .max(FIREWALL_MAX_CIDRS_PER_RULE),
  ports: z.array(zFirewallPortRange).max(FIREWALL_MAX_PORT_RANGES_PER_RULE),
}).strict().refine(
  (rule) => rule.protocol !== FirewallProtocol.All || rule.ports.length === 0,
  'ports require protocol tcp or udp',
);

export const zFirewallDocument = z.object({
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  rules: z.array(zFirewallRuleSpec).max(FIREWALL_MAX_RULES_PER_SERVER),
}).strict().refine(
  (document) => document.rules.reduce((sum, rule) => sum + rule.cidrs.length, 0) <= FIREWALL_MAX_CIDRS_PER_SERVER,
  `at most ${FIREWALL_MAX_CIDRS_PER_SERVER} CIDRs per server`,
);

const zFirewallName = z.string().trim().min(1).max(128);
const zFirewallDescription = z.string().trim().max(512);
const zFirewallPriority = z.number().int().min(FIREWALL_PRIORITY_MIN).max(FIREWALL_PRIORITY_MAX);
const zFirewallServerIds = z.array(z.string().uuid()).max(4_096).refine(
  (ids) => new Set(ids).size === ids.length,
  'serverIds must be unique',
);

export const zCreateFirewallRuleRequest = z.object({
  name: zFirewallName,
  description: zFirewallDescription.default(''),
  priority: zFirewallPriority,
  action: zFirewallAction,
  protocol: zFirewallProtocol,
  ports: zFirewallPortList.default([]),
  cidrs: zFirewallCidrList,
  serverIds: zFirewallServerIds.default([]),
}).strict().refine(
  (rule) => rule.protocol !== FirewallProtocol.All || rule.ports.length === 0,
  { path: ['ports'], message: 'ports require protocol tcp or udp' },
);

/** Absent fields keep their value; protocol `all` with (resulting) ports is refused by the service. */
export const zPatchFirewallRuleRequest = z.object({
  expectedRevision: z.number().int().positive().safe(),
  name: zFirewallName.optional(),
  description: zFirewallDescription.optional(),
  priority: zFirewallPriority.optional(),
  action: zFirewallAction.optional(),
  protocol: zFirewallProtocol.optional(),
  ports: zFirewallPortList.optional(),
  cidrs: zFirewallCidrList.optional(),
  serverIds: zFirewallServerIds.optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
  'At least one firewall rule field is required',
);

export type CreateFirewallRuleRequest = z.infer<typeof zCreateFirewallRuleRequest>;
export type PatchFirewallRuleRequest = z.infer<typeof zPatchFirewallRuleRequest>;

export interface FirewallRuleDto {
  id: string;
  name: string;
  description: string;
  priority: number;
  action: FirewallAction;
  protocol: FirewallProtocol;
  ports: FirewallPortRange[];
  cidrs: string[];
  serverIds: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * offline: no agent connection. synced: the agent confirmed the desired
 * document and its table verifies. pending: not yet. failed: the agent reports
 * an error or the last `firewall.apply` failed.
 */
export type FirewallSyncState = 'offline' | 'synced' | 'pending' | 'failed';

export interface FirewallServerStatusDto {
  serverId: string;
  serverName: string;
  /** Digest of the rules the server should enforce (an empty rule list has one too). */
  desiredDigest: string;
  agentConnected: boolean;
  /** Digest of the document the agent currently holds; null while offline or before it has one. */
  appliedDigest: string | null;
  ruleCount: number;
  state: FirewallSyncState;
  error: string | null;
}
