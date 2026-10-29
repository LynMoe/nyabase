import { Role, UserStatus } from '@nyabase/common';

export function userStatusLabel(status: string): string {
  switch (status) {
    case UserStatus.Active:
    case 'active':
      return '正常';
    case UserStatus.Disabled:
    case 'disabled':
      return '已停用';
    case UserStatus.Deleting:
    case 'deleting':
      return '删除中';
    case UserStatus.Deleted:
    case 'deleted':
      return '已删除';
    default:
      return status;
  }
}


export function roleLabel(role: string): string {
  switch (role) {
    case Role.User:
      return '用户';
    case Role.UserAdmin:
      return '用户管理员';
    case Role.Admin:
      return '超级管理员';
    default:
      return role;
  }
}


export function preflightStatusLabel(status: string): string {
  switch (status) {
    case 'not_run':
      return '未运行';
    case 'running':
      return '检查中';
    case 'passed':
      return '已通过';
    case 'failed':
      return '未通过';
    default:
      return status;
  }
}

const PREFLIGHT_CHECK_LABELS: Record<string, string> = {
  api: 'API 连通',
  parentInterface: 'LAN 网桥 (vmbr)',
  nftables: 'nftables',
  ipv4Filtering: 'IPv4 防伪',
  networkPrerequisites: '网络前置条件',
  storagePool: '存储池',
  simplestreamsImage: '镜像源',
  guestAddress: '容器 IP',
  nodeMetrics: '节点指标',
};

export function preflightCheckLabel(name: string): string {
  return PREFLIGHT_CHECK_LABELS[name] ?? name;
}

/**
 * The checks this build knows, in display order. Reports stored by an older
 * Backend may still carry retired checks; those are not shown.
 */
export function knownPreflightChecks(checks: Record<string, unknown>): Array<[string, unknown]> {
  return Object.keys(PREFLIGHT_CHECK_LABELS)
    .filter((name) => Object.hasOwn(checks, name))
    .map((name) => [name, checks[name]]);
}

export function preflightResultLabel(result: string): string {
  switch (result) {
    case 'pass':
      return '通过';
    case 'warn':
      return '警告';
    case 'fail':
      return '失败';
    case 'not_applicable':
      return '不适用';
    default:
      return result;
  }
}

export function grantExpiryPhaseLabel(phase: string): string {
  switch (phase) {
    case 'live':
      return '有效';
    case 'grace':
      return '宽限中';
    case 'lost':
      return '已失效';
    default:
      return phase;
  }
}

export function nodeMetricsStatusZh(status: string): string {
  switch (status) {
    case 'online':
      return '在线';
    case 'unreachable':
      return '不可达';
    case 'unknown':
      return '未知';
    default:
      return status;
  }
}

/** Storage overcommit as a sentence: "1" alone does not say whether that is a limit or a multiplier. */
export function storageOvercommitLabel(ratio: number | string): string {
  const value = Number(ratio);
  if (!Number.isFinite(value) || value <= 0) return String(ratio);
  if (value <= 1) return `${value}×（不超分，按物理容量分配）`;
  return `${value}×（所有用户合计最多分配物理容量的 ${value} 倍，单个用户不超过物理容量）`;
}

// One vocabulary for lifecycle and server status across the app.
export { lifecyclePhaseLabel, serverStatusLabel } from './status-labels.js';

export const ROLE_OPTIONS: Array<[string, string]> = [
  [Role.User, roleLabel(Role.User)],
  [Role.UserAdmin, roleLabel(Role.UserAdmin)],
  [Role.Admin, roleLabel(Role.Admin)],
];
