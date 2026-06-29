import { z } from 'zod';
import { ContainerStatus } from '../enums.js';

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
export const zHttpProxyTargetProtocol = z.enum(['http', 'https']);

export const zHttpProxyDomainPoolSnapshot = z.object({
  id: z.string(),
  wildcardDomain: z.string(),
  enabled: z.boolean(),
  httpsEnabled: z.boolean(),
  certificatePem: z.string().nullable(),
  privateKeyPem: z.string().nullable(),
  certificateFingerprint: z.string().nullable(),
  certificateNotAfter: z.string().nullable(),
});

export const zHttpProxyRouteSnapshot = z.object({
  bindingId: z.string(),
  hostname: z.string(),
  domainPoolId: z.string(),
  targetIp: z.string(),
  targetPort: z.number().int().min(1).max(65535),
  targetProtocol: zHttpProxyTargetProtocol,
  ownerId: z.string(),
  containerId: z.string(),
  containerName: z.string(),
  runtimeId: z.string(),
  runtimeStatus: z.nativeEnum(ContainerStatus),
});

export const zHttpProxySnapshot = z.object({
  generation: z.number().int().nonnegative(),
  createdAt: z.string(),
  routes: z.array(zHttpProxyRouteSnapshot),
  domainPools: z.array(zHttpProxyDomainPoolSnapshot),
});

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
export type HttpProxyTargetProtocol = z.infer<typeof zHttpProxyTargetProtocol>;
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
  return value.trim().replace(/\.$/, '').toLowerCase();
}

export function normalizeHttpProxyWildcardDomain(value: string): string {
  const normalized = normalizeHttpProxyHostname(value);
  return normalized.startsWith('*.') ? normalized : `*.${normalized}`;
}

export function httpProxyWildcardSuffix(wildcardDomain: string): string {
  const normalized = normalizeHttpProxyWildcardDomain(wildcardDomain);
  return normalized.slice(1);
}

export function hostnameMatchesHttpProxyWildcard(hostname: string, wildcardDomain: string): boolean {
  const host = normalizeHttpProxyHostname(hostname);
  const suffix = httpProxyWildcardSuffix(wildcardDomain);
  if (!host.endsWith(suffix)) return false;
  const prefix = host.slice(0, -suffix.length);
  return prefix.length > 0 && !prefix.includes('.');
}

export function resolveHttpProxyRoute(
  snapshot: Pick<HttpProxySnapshot, 'routes'>,
  hostHeader: string | null | undefined,
): HttpProxyRouteSnapshot | null {
  if (!hostHeader) return null;
  const hostname = normalizeHttpProxyHostname(hostHeader.split(':')[0] ?? '');
  if (!hostname) return null;
  return snapshot.routes.find((route) => route.hostname === hostname) ?? null;
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
