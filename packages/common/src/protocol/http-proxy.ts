import { z } from 'zod';
import { ContainerStatus } from '../enums.js';
import {
  MAX_HTTP_PROXY_CERTIFICATE_PEM_LENGTH,
  MAX_HTTP_PROXY_DOMAIN_POOLS,
  MAX_HTTP_PROXY_PRIVATE_KEY_PEM_LENGTH,
  MAX_HTTP_PROXY_ROUTES,
} from '../constants.js';

const zAscii = (max: number) => z.string().min(1).max(max).regex(/^[\x20-\x7e]+$/);
const zAsciiText = (max: number) => z.string().min(1).max(max)
  .regex(/^[\x09\x0a\x0d\x20-\x7e]+$/);
const zId = zAscii(64);

// Long enough to remain online after subtracting the shared 30s clock-skew
// allowance while still renewing well before expiry.
export const HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS = 120_000;
export const HTTP_PROXY_SNAPSHOT_MAX_STALE_AFTER_MS = 300_000;

export const HTTP_PROXY_WARNING_REASONS = [
  'container_deleted',
  'container_not_running',
  'container_runtime_missing',
  'container_runtime_stale',
  'container_ip_missing',
  'domain_pool_disabled',
  'https_not_configured',
  'route_missing',
  'proxy_offline',
] as const;

export const zHttpProxyWarningReason = z.enum(HTTP_PROXY_WARNING_REASONS);
export const zHttpProxyBindingStatus = z.enum(['ready', 'warning', 'disabled']);

export const zHttpProxyDomainPoolSnapshot = z.object({
  id: zId,
  wildcardDomain: zAscii(255),
  enabled: z.boolean(),
  httpsEnabled: z.boolean(),
  certificatePem: zAsciiText(MAX_HTTP_PROXY_CERTIFICATE_PEM_LENGTH).nullable(),
  privateKeyPem: zAsciiText(MAX_HTTP_PROXY_PRIVATE_KEY_PEM_LENGTH).nullable(),
  certificateFingerprint: zAscii(128).nullable(),
  certificateNotAfter: zAscii(64).nullable(),
}).strict();

export const zHttpProxyRouteSnapshot = z.object({
  bindingId: zId,
  hostname: zAscii(253),
  domainPoolId: zId,
  targetIp: zAscii(15),
  targetPort: z.number().int().min(1).max(65535),
  ownerId: zId,
  containerId: zId,
  containerName: zAscii(64),
  runtimeId: zAscii(128),
  runtimeStatus: z.nativeEnum(ContainerStatus),
}).strict();

export const zHttpProxySnapshot = z.object({
  generation: z.number().int().nonnegative(),
  createdAt: z.string().min(1).max(64),
  staleAfterMs: z.number().int().positive().max(HTTP_PROXY_SNAPSHOT_MAX_STALE_AFTER_MS),
  validUntil: z.number().int().positive(),
  routes: z.array(zHttpProxyRouteSnapshot).max(MAX_HTTP_PROXY_ROUTES),
  domainPools: z.array(zHttpProxyDomainPoolSnapshot).max(MAX_HTTP_PROXY_DOMAIN_POOLS),
}).strict();

export const zHttpProxyStatusReport = z.object({
  proxyId: z.string(),
  hostname: z.string().nullable(),
  httpListen: z.string(),
  httpsListen: z.string().nullable(),
  uptimeMs: z.number().int().nonnegative(),
  connectedAt: z.number(),
  lastSnapshotGeneration: z.number().int().nonnegative().nullable(),
  lastSnapshotAt: z.number().nullable(),
  activeConnections: z.number().int().nonnegative(),
  totalRequests: z.number().int().nonnegative(),
  totalRejectedRequests: z.number().int().nonnegative(),
});

export const zHttpProxyClientAck = z.object({
  generation: z.number().int().nonnegative(),
});

export type HttpProxyWarningReason = z.infer<typeof zHttpProxyWarningReason>;
export type HttpProxyBindingStatus = z.infer<typeof zHttpProxyBindingStatus>;
export type HttpProxyDomainPoolSnapshot = z.infer<typeof zHttpProxyDomainPoolSnapshot>;
export type HttpProxyRouteSnapshot = z.infer<typeof zHttpProxyRouteSnapshot>;
export type HttpProxySnapshot = z.infer<typeof zHttpProxySnapshot>;
export type HttpProxyStatusReport = z.infer<typeof zHttpProxyStatusReport>;
export type HttpProxyClientAck = z.infer<typeof zHttpProxyClientAck>;

export type HttpProxyBackendMessage =
  | { kind: 'snapshot'; payload: HttpProxySnapshot }
  | { kind: 'update'; payload: HttpProxySnapshot };

export type HttpProxyClientMessage =
  | { kind: 'ack'; payload: HttpProxyClientAck }
  | { kind: 'status'; payload: HttpProxyStatusReport };

export function normalizeHttpProxyHostname(value: string): string {
  const normalized = value.trim().replace(/\.$/, '').toLowerCase();
  if (!isValidAsciiDnsName(normalized)) throw new Error('Invalid ASCII DNS hostname');
  return normalized;
}

export function normalizeHttpProxyWildcardDomain(value: string): string {
  const raw = value.trim().replace(/\.$/, '').toLowerCase();
  const suffix = raw.startsWith('*.') ? raw.slice(2) : raw;
  if (!isValidAsciiDnsName(suffix) || suffix.split('.').length < 2) {
    throw new Error('Invalid wildcard DNS domain');
  }
  return `*.${suffix}`;
}

export function httpProxyWildcardSuffix(wildcardDomain: string): string {
  const normalized = normalizeHttpProxyWildcardDomain(wildcardDomain);
  return normalized.slice(1);
}

export function hostnameMatchesHttpProxyWildcard(hostname: string, wildcardDomain: string): boolean {
  let host: string;
  let suffix: string;
  try {
    host = normalizeHttpProxyHostname(hostname);
    suffix = httpProxyWildcardSuffix(wildcardDomain);
  } catch {
    return false;
  }
  if (!host.endsWith(suffix)) return false;
  const prefix = host.slice(0, -suffix.length);
  return prefix.length > 0 && !prefix.includes('.');
}

export function resolveHttpProxyRoute(
  snapshot: Pick<HttpProxySnapshot, 'routes'>,
  hostHeader: string | null | undefined,
): HttpProxyRouteSnapshot | null {
  if (!hostHeader) return null;
  let hostname: string;
  try {
    hostname = normalizeHttpProxyHostname(hostHeader.split(':')[0] ?? '');
  } catch {
    return null;
  }
  if (!hostname) return null;
  return snapshot.routes.find((route) => route.hostname === hostname) ?? null;
}

export function isValidAsciiDnsName(value: string): boolean {
  if (value.length < 1 || value.length > 253 || value.includes('..')) return false;
  const labels = value.split('.');
  return labels.every((label) => label.length >= 1
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export function httpProxyWarningMessage(reasons: HttpProxyWarningReason[]): string {
  if (reasons.length === 0) return '';
  const labels: Record<HttpProxyWarningReason, string> = {
    container_deleted: '容器已删除',
    container_not_running: '容器未运行',
    container_runtime_missing: '运行时未绑定',
    container_runtime_stale: '运行态已过期',
    container_ip_missing: '容器 IP 缺失',
    domain_pool_disabled: '域名池已禁用',
    https_not_configured: '入口 HTTPS 未配置证书',
    route_missing: '代理路由缺失',
    proxy_offline: 'HTTP 代理离线',
  };
  return reasons.map((reason) => labels[reason]).join('、');
}
