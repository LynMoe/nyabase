import {
  hostnameMatchesHttpProxyWildcard,
  httpProxyWildcardSuffix,
  normalizeHttpProxyHostname,
  type HttpDomainPoolPublicDto,
  type HttpProxyBindingDto,
  type HttpProxyBindingStatus,
  type HttpProxyWarningReason,
} from '@nyabase/common';
import { ApiError } from './api-error.js';

const WARNING_LABELS: Record<HttpProxyWarningReason, string> = {
  container_deleted: '容器已删除',
  container_not_running: '容器未运行',
  container_instance_missing: '容器实例缺失',
  container_stale: '容器观测已过期',
  container_ip_missing: '容器 IP 缺失',
  domain_pool_disabled: '域名池已停用',
  https_not_configured: 'HTTPS 证书未配置',
  route_missing: '代理路由缺失',
  proxy_offline: 'HTTP 代理离线',
};

export function httpProxyBindingStatusLabel(status: HttpProxyBindingStatus): string {
  switch (status) {
    case 'ready':
      return '就绪';
    case 'warning':
      return '需关注';
    case 'disabled':
      return '已停用';
    default:
      return status;
  }
}

export function httpProxyWarningLabel(reasons: readonly HttpProxyWarningReason[]): string {
  return reasons.map((reason) => WARNING_LABELS[reason] ?? reason).join('；');
}

/**
 * What the owner sees of a binding's state. HTTPS on the entry is the
 * operators' business (domain-pool certificates), so its warning is not shown
 * to users and alone does not make a binding look unhealthy.
 */
export function userVisibleBindingState(
  binding: Pick<HttpProxyBindingDto, 'status' | 'warningReasons'>,
): { status: HttpProxyBindingStatus; warning: string } {
  const reasons = binding.warningReasons.filter((reason) => reason !== 'https_not_configured');
  const status = binding.status === 'warning' && reasons.length === 0 ? 'ready' : binding.status;
  return { status, warning: httpProxyWarningLabel(reasons) };
}

/** Request counts: grouped digits below 10 000, then 万 / 亿 with one decimal. */
export function formatRequestCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '—';
  const compact = (value: number, unit: string) => {
    const text = value < 100 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value));
    return `${text}${unit}`;
  };
  // 9999.95万 would print as 10000万.
  if (count >= 99_995_000) return compact(count / 1e8, '亿');
  if (count >= 1e4) return compact(count / 1e4, '万');
  return Math.round(count).toLocaleString('zh-CN');
}

/** Treat a missing public domain-pools endpoint as an empty list. */
export function emptyIfNotFound<T>(fallback: T) {
  return (error: unknown): T => {
    if (error instanceof ApiError && error.status === 404) return fallback;
    throw error;
  };
}

const HTTP_PROXY_ERROR_ZH: Record<string, string> = {
  'HTTPS requires a valid certificate and private key': '启用 HTTPS 时必须提供有效的证书和私钥',
  'Domain pool still has bindings': '该域名池仍有 HTTP 发布，请先让用户删除发布或先停用该池',
  'Hostname is not under an enabled wildcard domain pool': '主机名不在任何已启用的通配域名下',
  'hostname must be a valid ASCII DNS hostname without a wildcard': '主机名必须是不含通配符的 ASCII 域名',
  'wildcardDomain must be a valid ASCII DNS wildcard domain': '通配域名必须是 ASCII 格式，例如 *.example.com',
  'A domain pool already owns this wildcard domain': '该通配域名已被其他域名池占用',
};

export function httpProxyErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '请稍后重试';
  if (message.startsWith('Certificate does not cover wildcard domain')) {
    return '证书未覆盖该通配域名';
  }
  return HTTP_PROXY_ERROR_ZH[message] ?? message;
}

export function httpProxyDomainRootLabel(wildcardDomain: string): string {
  return httpProxyWildcardSuffix(wildcardDomain).replace(/^\./, '');
}

export function isHttpProxyPrefixLabel(value: string): boolean {
  const label = value.trim().toLowerCase();
  return label.length >= 1
    && label.length <= 63
    && !label.includes('.')
    && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}

export function composeHttpProxyHostname(prefix: string, wildcardDomain: string): string {
  return normalizeHttpProxyHostname(`${prefix.trim().toLowerCase()}${httpProxyWildcardSuffix(wildcardDomain)}`);
}

export function splitHttpProxyHostname(
  hostname: string,
  pools: readonly Pick<HttpDomainPoolPublicDto, 'id' | 'wildcardDomain'>[],
): { prefix: string; poolId: string } | null {
  let host: string;
  try {
    host = normalizeHttpProxyHostname(hostname);
  } catch {
    return null;
  }
  for (const pool of pools) {
    if (!hostnameMatchesHttpProxyWildcard(host, pool.wildcardDomain)) continue;
    const suffix = httpProxyWildcardSuffix(pool.wildcardDomain);
    return { prefix: host.slice(0, -suffix.length), poolId: pool.id };
  }
  return null;
}
