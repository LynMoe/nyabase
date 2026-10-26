import { describe, expect, it } from 'vitest';
import {
  FailureCode,
  FIREWALL_MAX_CIDRS_PER_RULE,
  FirewallAction,
  FirewallProtocol,
  type FirewallRuleDto,
  type FirewallServerStatusDto,
} from '@nyabase/common';
import { ApiError } from './api-error.js';
import {
  agentFirewallBadge,
  defaultFirewallPriority,
  emptyFirewallRuleForm,
  firewallActionLabel,
  firewallActionTone,
  firewallCidrCount,
  firewallErrorMessage,
  firewallProtocolPortsLabel,
  firewallRuleForm,
  firewallRulePatch,
  firewallSyncBadge,
  hasPendingFirewallSync,
  parseFirewallCidrsField,
  parseFirewallPortsField,
  validateFirewallRuleForm,
  type FirewallRuleForm,
} from './firewall-rules.js';

const SERVER_A = '11111111-1111-4111-8111-111111111111';
const SERVER_B = '22222222-2222-4222-8222-222222222222';

function rule(overrides: Partial<FirewallRuleDto> = {}): FirewallRuleDto {
  return {
    id: 'r1',
    name: 'block-lan',
    description: '',
    priority: 100,
    action: FirewallAction.Drop,
    protocol: FirewallProtocol.Tcp,
    ports: [{ from: 22, to: 22 }, { from: 8000, to: 9000 }],
    cidrs: ['10.0.0.0/8', '192.168.1.10/32'],
    serverIds: [SERVER_A],
    revision: 3,
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    ...overrides,
  };
}

function status(state: FirewallServerStatusDto['state']): FirewallServerStatusDto {
  return {
    serverId: SERVER_A,
    serverName: 'a',
    desiredDigest: 'd',
    agentConnected: state !== 'offline',
    appliedDigest: null,
    ruleCount: 1,
    state,
    error: null,
  };
}

function validForm(overrides: Partial<FirewallRuleForm> = {}): FirewallRuleForm {
  return { ...firewallRuleForm(rule()), ...overrides };
}

describe('firewall rule labels', () => {
  it('names and colours the three actions differently', () => {
    expect(firewallActionLabel(FirewallAction.Accept)).toBe('放行');
    expect(firewallActionLabel(FirewallAction.Reject)).toBe('拒绝（reject）');
    expect(firewallActionLabel(FirewallAction.Drop)).toBe('丢弃（drop）');
    const tones = [FirewallAction.Accept, FirewallAction.Reject, FirewallAction.Drop].map(firewallActionTone);
    expect(new Set(tones).size).toBe(3);
  });

  it('describes protocol and ports', () => {
    expect(firewallProtocolPortsLabel({ protocol: FirewallProtocol.All, ports: [] })).toBe('全部协议');
    expect(firewallProtocolPortsLabel({ protocol: FirewallProtocol.Udp, ports: [] })).toBe('UDP 全部端口');
    expect(firewallProtocolPortsLabel(rule())).toBe('TCP 22, 8000-9000');
  });

  it('labels sync states, and a disconnected agent as offline', () => {
    expect(firewallSyncBadge('synced').label).toBe('已同步');
    expect(firewallSyncBadge('pending')).toMatchObject({ label: '同步中', pending: true });
    expect(firewallSyncBadge('failed').tone).toBe('destructive');
    expect(firewallSyncBadge('offline').label).toBe('离线');
    expect(agentFirewallBadge(null).label).toBe('防火墙离线');
    expect(agentFirewallBadge({ state: 'failed', error: 'nft' }).label).toBe('防火墙同步失败');
    expect(agentFirewallBadge({ state: 'synced', error: null }).tone).toBe('success');
  });

  it('polls only while some server is pending', () => {
    expect(hasPendingFirewallSync(undefined)).toBe(false);
    expect(hasPendingFirewallSync([status('synced'), status('failed'), status('offline')])).toBe(false);
    expect(hasPendingFirewallSync([status('synced'), status('pending')])).toBe(true);
  });
});

describe('firewall rule form', () => {
  it('defaults a new rule after the last one', () => {
    expect(defaultFirewallPriority([])).toBe(100);
    expect(defaultFirewallPriority([{ priority: 30 }, { priority: 250 }])).toBe(260);
    expect(defaultFirewallPriority([{ priority: 999_995 }])).toBe(1_000_000);
    expect(emptyFirewallRuleForm(260).priority).toBe('260');
  });

  it('parses ports, ignoring them for protocol all', () => {
    expect(parseFirewallPortsField('22, 80，8000-9000 80', FirewallProtocol.Tcp)).toEqual({
      ports: [{ from: 22, to: 22 }, { from: 80, to: 80 }, { from: 8000, to: 9000 }],
      error: null,
    });
    expect(parseFirewallPortsField('', FirewallProtocol.Udp)).toEqual({ ports: [], error: null });
    expect(parseFirewallPortsField('22-x', FirewallProtocol.Tcp).error).toBe('无效的端口：22-x');
    expect(parseFirewallPortsField('70000', FirewallProtocol.Tcp).error).toBe('无效的端口：70000');
    expect(parseFirewallPortsField('garbage', FirewallProtocol.All)).toEqual({ ports: [], error: null });
    const many = Array.from({ length: 40 }, (_, index) => String(index * 2 + 1)).join(',');
    expect(parseFirewallPortsField(many, FirewallProtocol.Tcp).error).toContain('最多 32');
  });

  it('parses one CIDR per line and names the bad line', () => {
    expect(parseFirewallCidrsField('10.1.2.3/8\n\n 192.168.1.10 \n10.0.0.0/8')).toEqual({
      cidrs: ['10.0.0.0/8', '192.168.1.10/32'],
      error: null,
    });
    expect(parseFirewallCidrsField('10.0.0.0/8\n\n10.0.0.300').error).toBe('第 3 行「10.0.0.300」不是有效的 IPv4 地址或网段');
    expect(parseFirewallCidrsField('  \n').error).toBe('至少填写一个网段');
    const tooMany = Array.from({ length: FIREWALL_MAX_CIDRS_PER_RULE + 1 }, (_, index) => `10.0.${index >> 8}.${index & 255}`).join('\n');
    expect(firewallCidrCount(tooMany)).toBe(FIREWALL_MAX_CIDRS_PER_RULE + 1);
    expect(parseFirewallCidrsField(tooMany).error).toContain(`最多 ${FIREWALL_MAX_CIDRS_PER_RULE}`);
  });

  it('validates the whole form into a create body', () => {
    const result = validateFirewallRuleForm(validForm({ name: '  block  ', description: ' note ' }));
    expect(result.errors).toBeNull();
    expect(result.body).toEqual({
      name: 'block',
      description: 'note',
      priority: 100,
      action: FirewallAction.Drop,
      protocol: FirewallProtocol.Tcp,
      ports: [{ from: 22, to: 22 }, { from: 8000, to: 9000 }],
      cidrs: ['10.0.0.0/8', '192.168.1.10/32'],
      serverIds: [SERVER_A],
    });
    const invalid = validateFirewallRuleForm(validForm({ name: ' ', priority: '0', ports: 'x', cidrs: '' }));
    expect(invalid.body).toBeNull();
    expect(invalid.errors).toMatchObject({
      name: '请填写名称',
      priority: expect.stringContaining('1–1000000'),
      ports: '无效的端口：x',
      cidrs: '至少填写一个网段',
    });
    expect(validateFirewallRuleForm(validForm({ priority: '1.5' })).errors?.priority).toBeDefined();
  });

  it('patches only what changed, with the revision', () => {
    const current = rule();
    const same = validateFirewallRuleForm(firewallRuleForm(current)).body!;
    expect(firewallRulePatch(current, same)).toBeNull();
    // Reordered input that canonicalizes to the same rule is not a change either.
    const reordered = validateFirewallRuleForm(validForm({ cidrs: '192.168.1.10\n10.1.0.0/8', ports: '8000-9000, 22' })).body!;
    expect(firewallRulePatch(current, reordered)).toBeNull();
    const changed = validateFirewallRuleForm(validForm({
      priority: '120',
      protocol: FirewallProtocol.All,
      ports: '',
      serverIds: [SERVER_B, SERVER_A],
    })).body!;
    expect(firewallRulePatch(current, changed)).toEqual({
      expectedRevision: 3,
      priority: 120,
      protocol: FirewallProtocol.All,
      ports: [],
      serverIds: [SERVER_B, SERVER_A],
    });
  });

  it('turns firewall failure codes into actionable messages', () => {
    expect(firewallErrorMessage(new ApiError(409, FailureCode.FirewallRuleConflict, 'duplicate'))).toContain('名称或优先级');
    const tooLarge = new ApiError(400, FailureCode.FirewallTooLarge, 'too large', { details: { serverId: SERVER_A } });
    expect(firewallErrorMessage(tooLarge, (id) => (id === SERVER_A ? 'node-a' : undefined))).toBe(
      '服务器「node-a」关联的规则超出上限：每台服务器最多 256 条规则、合计 4096 个网段',
    );
    expect(firewallErrorMessage(new ApiError(409, FailureCode.RevisionConflict, 'stale'))).toContain('刷新');
    expect(firewallErrorMessage(new ApiError(400, 'INVALID_INPUT', '参数无效'))).toBe('参数无效');
  });
});
