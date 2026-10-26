import type { ListScope } from '@nyabase/common';

/**
 * Labels for the codes the SSH connection history stores: why a connection
 * or channel closed, which requests were refused, and why an unauthenticated
 * connection was counted. Unknown codes are shown as they are.
 */
const LABELS: Record<string, string> = {
  // Close reasons.
  client_closed: '客户端断开',
  closed: '正常结束',
  connection_closed: '随连接结束',
  disconnect_all: '管理员断开全部',
  revoked: '授权被撤销',
  proxy_unavailable: '代理与后端失联',
  control_paused: '代理暂停接入',
  keepalive_timeout: '心跳超时',
  idle_timeout: '空闲超时',
  network_error: '网络错误',
  protocol_error: '协议错误',
  error: '出错',
  aborted: '被中止',
  lost: '未收到关闭记录',
  // Refused requests and channels.
  session: '打开 shell / exec 会话',
  remote_forward: '远程端口转发（-R）',
  cancel_remote_forward: '取消远程转发',
  direct_streamlocal: 'Unix 套接字转发',
  remote_streamlocal_forward: '远程 Unix 套接字转发',
  rejected_permit: '转发到非 22 端口（-L / -D）',
  rejected_unauthorized: '目标不是自己的容器',
  rejected_limit: '超出通道数上限',
  rejected_child_limit: '超出任务数上限',
  rejected_revoked: '连接期间授权被撤销',
  rejected_paused: '代理暂停接入',
  connect_failed: '连接容器失败',
  connect_timeout: '连接容器超时',
  opened: '已打开',
  // Unauthenticated connections.
  public_key_rejected: '公钥被拒绝',
  invalid_login: '用户名无效',
  snapshot_unavailable: '路由尚未就绪',
  user_not_found: '用户不存在',
  user_disabled: '用户已禁用',
  ambiguous_user: '公钥对应多个用户',
  no_auth: '未尝试认证',
  auth_timeout: '认证超时',
  preauth_evicted: '认证前被挤出',
  paused: '代理暂停接入',
  rejected_client_limit: '超出单地址连接上限',
  rejected_site_limit: '超出网段连接上限',
  rejected_preauth_limit: '超出认证前连接上限',
};

export function sshHistoryLabel(code: string): string {
  return LABELS[code] ?? code;
}

export interface SshSessionFilters {
  containerId?: string;
  peerIp?: string;
  state?: 'open' | 'closed';
}

function query(entries: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export function sshSessionsPath(
  scope: ListScope,
  filters: SshSessionFilters,
  page: { limit: number; cursor?: string },
): string {
  return `/ssh-sessions${query({
    scope: scope === 'all' ? 'all' : undefined,
    limit: page.limit,
    cursor: page.cursor,
    containerId: filters.containerId,
    peerIp: filters.peerIp,
    state: filters.state,
  })}`;
}

export function sshSessionPath(scope: ListScope, id: string): string {
  return `/ssh-sessions/${encodeURIComponent(id)}${query({ scope: scope === 'all' ? 'all' : undefined })}`;
}

export function sshSessionStatsPath(scope: ListScope, days: number, containerId?: string): string {
  return `/ssh-sessions/stats${query({ scope: scope === 'all' ? 'all' : undefined, days, containerId })}`;
}

export function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString();
}

/** `10/26 11:41:59` (with the year when it is not this year), for table cells. */
export function formatShortTime(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知';
  const pad = (part: number) => String(part).padStart(2, '0');
  const day = `${date.getMonth() + 1}/${date.getDate()}`;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}/`}${day} ${clock}`;
}

/** `1 小时 5 分`, `42 秒`; the end is now for an open connection. */
export function formatDuration(from: string, to: string | null, now = Date.now()): string {
  const ms = Math.max(0, (to ? new Date(to).getTime() : now) - new Date(from).getTime());
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days} 天${hours % 24 ? ` ${hours % 24} 小时` : ''}`;
}

/** The sum of every count, for a "被拒 n 次" cell. */
export function totalCount(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

/** Entries sorted by count, largest first. */
export function sortedCounts(counts: Record<string, number>): Array<[string, number]> {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
