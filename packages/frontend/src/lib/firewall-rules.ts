import {
  canonicalFirewallCidr,
  canonicalFirewallCidrs,
  canonicalFirewallPorts,
  FailureCode,
  FIREWALL_MAX_CIDRS_PER_RULE,
  FIREWALL_MAX_CIDRS_PER_SERVER,
  FIREWALL_MAX_PORT_RANGES_PER_RULE,
  FIREWALL_MAX_RULES_PER_SERVER,
  FIREWALL_PRIORITY_MAX,
  FIREWALL_PRIORITY_MIN,
  FirewallAction,
  FirewallProtocol,
  formatFirewallPorts,
  parseFirewallPorts,
  zCreateFirewallRuleRequest,
  type CreateFirewallRuleRequest,
  type FirewallPortRange,
  type FirewallRuleDto,
  type FirewallServerStatusDto,
  type FirewallSyncState,
  type PatchFirewallRuleRequest,
  type ServerAgentDto,
} from '@nyabase/common';
import { ApiError, apiErrorDetails, errorMessage } from './api-error.js';

export type BadgeTone = 'success' | 'secondary' | 'destructive' | 'warning';

export const FIREWALL_ACTION_OPTIONS: Array<[FirewallAction, string]> = [
  [FirewallAction.Accept, '放行'],
  [FirewallAction.Reject, '拒绝（reject）'],
  [FirewallAction.Drop, '丢弃（drop）'],
];

export const FIREWALL_PROTOCOL_OPTIONS: Array<[FirewallProtocol, string]> = [
  [FirewallProtocol.All, '全部协议'],
  [FirewallProtocol.Tcp, 'TCP'],
  [FirewallProtocol.Udp, 'UDP'],
];

const ACTION_TONE: Record<FirewallAction, BadgeTone> = {
  accept: 'success',
  reject: 'warning',
  drop: 'destructive',
};

export function firewallActionLabel(action: FirewallAction): string {
  return FIREWALL_ACTION_OPTIONS.find(([value]) => value === action)?.[1] ?? action;
}

export function firewallActionTone(action: FirewallAction): BadgeTone {
  return ACTION_TONE[action] ?? 'secondary';
}

/** 「全部协议」, or the protocol with its ports (「全部端口」 when none are listed). */
export function firewallProtocolPortsLabel(rule: Pick<FirewallRuleDto, 'protocol' | 'ports'>): string {
  if (rule.protocol === FirewallProtocol.All) return '全部协议';
  const ports = rule.ports.length > 0 ? formatFirewallPorts(rule.ports) : '全部端口';
  return `${rule.protocol.toUpperCase()} ${ports}`;
}

const SYNC_STATE: Record<FirewallSyncState, { label: string; tone: BadgeTone; pending: boolean }> = {
  synced: { label: '已同步', tone: 'success', pending: false },
  pending: { label: '同步中', tone: 'warning', pending: true },
  failed: { label: '失败', tone: 'destructive', pending: false },
  offline: { label: '离线', tone: 'secondary', pending: false },
};

export function firewallSyncBadge(state: FirewallSyncState): { label: string; tone: BadgeTone; pending: boolean } {
  return SYNC_STATE[state] ?? { label: state, tone: 'secondary', pending: false };
}

const AGENT_FIREWALL_LABEL: Record<FirewallSyncState, string> = {
  synced: '防火墙已同步',
  pending: '防火墙同步中',
  failed: '防火墙同步失败',
  offline: '防火墙离线',
};

/** The server card's 防火墙 badge; a disconnected agent (null) reads as 离线. */
export function agentFirewallBadge(firewall: ServerAgentDto['firewall']) {
  const state = firewall?.state ?? 'offline';
  return { ...firewallSyncBadge(state), label: AGENT_FIREWALL_LABEL[state] };
}

/** Poll the status endpoint only while some server has not caught up yet. */
export function hasPendingFirewallSync(statuses: readonly FirewallServerStatusDto[] | undefined): boolean {
  return (statuses ?? []).some((status) => status.state === 'pending');
}

/** New rules go after the last one: max + 10, or 100 when there are none. */
export function defaultFirewallPriority(rules: readonly Pick<FirewallRuleDto, 'priority'>[]): number {
  if (rules.length === 0) return 100;
  const max = Math.max(...rules.map((rule) => rule.priority));
  return Math.min(FIREWALL_PRIORITY_MAX, max + 10);
}

export interface FirewallRuleForm {
  name: string;
  description: string;
  priority: string;
  action: FirewallAction;
  protocol: FirewallProtocol;
  ports: string;
  cidrs: string;
  serverIds: string[];
}

export function emptyFirewallRuleForm(priority: number): FirewallRuleForm {
  return {
    name: '',
    description: '',
    priority: String(priority),
    action: FirewallAction.Drop,
    protocol: FirewallProtocol.All,
    ports: '',
    cidrs: '',
    serverIds: [],
  };
}

export function firewallRuleForm(rule: FirewallRuleDto): FirewallRuleForm {
  return {
    name: rule.name,
    description: rule.description,
    priority: String(rule.priority),
    action: rule.action,
    protocol: rule.protocol,
    ports: formatFirewallPorts(rule.ports),
    cidrs: rule.cidrs.join('\n'),
    serverIds: [...rule.serverIds],
  };
}

function cidrLines(text: string): Array<{ line: number; value: string }> {
  return text.split('\n')
    .map((value, index) => ({ line: index + 1, value: value.trim() }))
    .filter((entry) => entry.value.length > 0);
}

/** Non-empty lines in the 目标网段 textarea. */
export function firewallCidrCount(text: string): number {
  return cidrLines(text).length;
}

export function parseFirewallCidrsField(text: string): { cidrs: string[]; error: string | null } {
  const lines = cidrLines(text);
  if (lines.length === 0) return { cidrs: [], error: '至少填写一个网段' };
  for (const { line, value } of lines) {
    try {
      canonicalFirewallCidr(value);
    } catch {
      return { cidrs: [], error: `第 ${line} 行「${value}」不是有效的 IPv4 地址或网段` };
    }
  }
  if (lines.length > FIREWALL_MAX_CIDRS_PER_RULE) {
    return { cidrs: [], error: `每条规则最多 ${FIREWALL_MAX_CIDRS_PER_RULE} 个网段` };
  }
  return { cidrs: canonicalFirewallCidrs(lines.map((entry) => entry.value)), error: null };
}

export function parseFirewallPortsField(
  text: string,
  protocol: FirewallProtocol,
): { ports: FirewallPortRange[]; error: string | null } {
  if (protocol === FirewallProtocol.All) return { ports: [], error: null };
  let ports: FirewallPortRange[];
  try {
    ports = parseFirewallPorts(text);
  } catch (error) {
    return { ports: [], error: errorMessage(error, '端口格式无效') };
  }
  if (ports.length > FIREWALL_MAX_PORT_RANGES_PER_RULE) {
    return { ports: [], error: `每条规则最多 ${FIREWALL_MAX_PORT_RANGES_PER_RULE} 个端口项` };
  }
  return { ports: canonicalFirewallPorts(ports), error: null };
}

export interface FirewallFormErrors {
  name?: string;
  priority?: string;
  ports?: string;
  cidrs?: string;
  form?: string;
}

/** The whole form as a create body, or the per-field errors that stop it. */
export function validateFirewallRuleForm(
  form: FirewallRuleForm,
): { body: CreateFirewallRuleRequest; errors: null } | { body: null; errors: FirewallFormErrors } {
  const errors: FirewallFormErrors = {};
  if (!form.name.trim()) errors.name = '请填写名称';
  else if (form.name.trim().length > 128) errors.name = '名称最多 128 个字符';
  const priority = Number(form.priority.trim());
  if (!/^\d+$/.test(form.priority.trim()) || priority < FIREWALL_PRIORITY_MIN || priority > FIREWALL_PRIORITY_MAX) {
    errors.priority = `优先级须为 ${FIREWALL_PRIORITY_MIN}–${FIREWALL_PRIORITY_MAX} 的整数`;
  }
  const ports = parseFirewallPortsField(form.ports, form.protocol);
  if (ports.error) errors.ports = ports.error;
  const cidrs = parseFirewallCidrsField(form.cidrs);
  if (cidrs.error) errors.cidrs = cidrs.error;
  if (Object.keys(errors).length > 0) return { body: null, errors };
  const parsed = zCreateFirewallRuleRequest.safeParse({
    name: form.name,
    description: form.description,
    priority,
    action: form.action,
    protocol: form.protocol,
    ports: ports.ports,
    cidrs: cidrs.cidrs,
    serverIds: form.serverIds,
  });
  if (!parsed.success) return { body: null, errors: { form: parsed.error.issues[0]?.message ?? '请检查规则参数' } };
  return { body: parsed.data, errors: null };
}

function sameList<T>(left: readonly T[], right: readonly T[], key: (item: T) => string): boolean {
  if (left.length !== right.length) return false;
  const a = left.map(key).sort();
  const b = right.map(key).sort();
  return a.every((item, index) => item === b[index]);
}

const portKey = (range: FirewallPortRange) => `${range.from}-${range.to}`;

/** Only the fields that differ from `rule`, plus its revision; null when nothing changed. */
export function firewallRulePatch(rule: FirewallRuleDto, next: CreateFirewallRuleRequest): PatchFirewallRuleRequest | null {
  const patch: PatchFirewallRuleRequest = { expectedRevision: rule.revision };
  if (next.name !== rule.name) patch.name = next.name;
  if (next.description !== rule.description) patch.description = next.description;
  if (next.priority !== rule.priority) patch.priority = next.priority;
  if (next.action !== rule.action) patch.action = next.action;
  if (next.protocol !== rule.protocol) patch.protocol = next.protocol;
  if (!sameList(next.ports, canonicalFirewallPorts(rule.ports), portKey)) patch.ports = next.ports;
  if (!sameList(next.cidrs, rule.cidrs, String)) patch.cidrs = next.cidrs;
  if (!sameList(next.serverIds, rule.serverIds, String)) patch.serverIds = next.serverIds;
  return Object.keys(patch).length > 1 ? patch : null;
}

/** Mutation errors in words an admin can act on; unknown codes keep the server's message. */
export function firewallErrorMessage(error: unknown, serverName: (id: string) => string | undefined = () => undefined): string {
  if (error instanceof ApiError) {
    if (error.code === FailureCode.FirewallRuleConflict) return '名称或优先级与已有规则重复，请换一个';
    if (error.code === FailureCode.RevisionConflict) return '规则已被他人修改，请关闭后刷新再编辑';
    if (error.code === FailureCode.FirewallTooLarge) {
      const serverId = apiErrorDetails(error)?.serverId;
      const where = typeof serverId === 'string' ? `服务器「${serverName(serverId) ?? serverId}」` : '某台服务器';
      return `${where}关联的规则超出上限：每台服务器最多 ${FIREWALL_MAX_RULES_PER_SERVER} 条规则、合计 ${FIREWALL_MAX_CIDRS_PER_SERVER} 个网段`;
    }
  }
  return errorMessage(error, '操作失败');
}
