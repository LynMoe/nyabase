import { z } from 'zod';
import { ContainerStatus } from '../enums.js';
import {
  MAX_HTTP_PROXY_ACTIVE_CONNECTIONS,
  MAX_HTTP_PROXY_CERTIFICATE_PEM_LENGTH,
  MAX_HTTP_PROXY_DOMAIN_POOLS,
  MAX_HTTP_PROXY_PRIVATE_KEY_PEM_LENGTH,
  MAX_HTTP_PROXY_ROUTES,
  PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
} from '../constants.js';

const zAscii = (max: number) => z.string().min(1).max(max).regex(/^[\x20-\x7e]+$/);
const zAsciiText = (max: number) => z.string().min(1).max(max)
  .regex(/^[\x09\x0a\x0d\x20-\x7e]+$/);
const zId = zAscii(64);
const zSafeCounter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const zProxyTimestampMs = zSafeCounter.refine(
  (value) => value <= Date.now() + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
  'Proxy timestamp exceeds the allowed clock-skew window',
);

export const HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS = 120_000;
export const HTTP_PROXY_SNAPSHOT_MAX_STALE_AFTER_MS = 300_000;

export const HTTP_PROXY_WARNING_REASONS = [
  'container_deleted',
  'container_not_running',
  'container_instance_missing',
  'container_stale',
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
  routedIp: zAscii(15),
  targetPort: z.number().int().min(1).max(65_535),
  ownerId: zId,
  containerId: zId,
  containerName: zAscii(64),
  instanceName: zAscii(63),
  status: z.nativeEnum(ContainerStatus),
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
  proxyId: zAscii(128),
  hostname: zAscii(253).nullable(),
  httpListen: zAscii(128),
  httpsListen: zAscii(128).nullable(),
  uptimeMs: zSafeCounter,
  connectedAt: zProxyTimestampMs,
  lastSnapshotGeneration: zSafeCounter.nullable(),
  lastSnapshotAt: zProxyTimestampMs.nullable(),
  activeConnections: z.number().int().min(0).max(MAX_HTTP_PROXY_ACTIVE_CONNECTIONS),
  totalRequests: zSafeCounter,
  totalRejectedRequests: zSafeCounter,
}).strict();

export const zHttpProxyClientAck = z.object({
  generation: z.number().int().nonnegative(),
}).strict();

const zNullablePem = (max: number) => z.union([
  z.null(),
  z.string().max(max),
]).transform((value) => {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
});

export const zCreateHttpProxyBindingRequest = z.object({
  hostname: z.string().trim().min(1).max(253),
  containerId: z.string().trim().min(1).max(64),
  targetPort: z.number().int().min(1).max(65_535),
}).strict();

export const zPatchHttpProxyBindingRequest = zCreateHttpProxyBindingRequest.partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  'At least one binding field must be updated',
);

export const zCreateHttpDomainPoolRequest = z.object({
  wildcardDomain: z.string().trim().min(1).max(255),
  enabled: z.boolean().optional(),
  httpsEnabled: z.boolean().optional(),
  certificatePem: zNullablePem(MAX_HTTP_PROXY_CERTIFICATE_PEM_LENGTH).optional(),
  privateKeyPem: zNullablePem(MAX_HTTP_PROXY_PRIVATE_KEY_PEM_LENGTH).optional(),
}).strict();

export const zPatchHttpDomainPoolRequest = z.object({
  wildcardDomain: z.string().trim().min(1).max(255).optional(),
  enabled: z.boolean().optional(),
  httpsEnabled: z.boolean().optional(),
  certificatePem: zNullablePem(MAX_HTTP_PROXY_CERTIFICATE_PEM_LENGTH).optional(),
  privateKeyPem: zNullablePem(MAX_HTTP_PROXY_PRIVATE_KEY_PEM_LENGTH).optional(),
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  'At least one domain pool field must be updated',
);

export type HttpProxyWarningReason = z.infer<typeof zHttpProxyWarningReason>;
export type HttpProxyBindingStatus = z.infer<typeof zHttpProxyBindingStatus>;
export type HttpProxyDomainPoolSnapshot = z.infer<typeof zHttpProxyDomainPoolSnapshot>;
export type HttpProxyRouteSnapshot = z.infer<typeof zHttpProxyRouteSnapshot>;
export type HttpProxySnapshot = z.infer<typeof zHttpProxySnapshot>;
export type HttpProxyStatusReport = z.infer<typeof zHttpProxyStatusReport>;
export type HttpProxyClientAck = z.infer<typeof zHttpProxyClientAck>;
export type CreateHttpProxyBindingRequest = z.infer<typeof zCreateHttpProxyBindingRequest>;
export type PatchHttpProxyBindingRequest = z.infer<typeof zPatchHttpProxyBindingRequest>;
export type CreateHttpDomainPoolRequest = z.infer<typeof zCreateHttpDomainPoolRequest>;
export type PatchHttpDomainPoolRequest = z.infer<typeof zPatchHttpDomainPoolRequest>;

export interface HttpProxyBindingDto {
  id: string;
  mine: boolean;
  ownerId: string;
  ownerUsername: string;
  hostname: string;
  domainPoolId: string;
  domainPool: string;
  targetUrl: string | null;
  containerId: string;
  containerName: string | null;
  containerStatus: ContainerStatus | 'missing' | null;
  targetPort: number;
  entryHttpsEnabled: boolean;
  status: HttpProxyBindingStatus;
  warningReasons: HttpProxyWarningReason[];
  warningMessage: string;
  createdAt: string;
  updatedAt: string;
}

export interface HttpDomainPoolDto {
  id: string;
  wildcardDomain: string;
  enabled: boolean;
  httpsEnabled: boolean;
  certificateFingerprint: string | null;
  certificateNotAfter: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HttpDomainPoolPublicDto {
  id: string;
  wildcardDomain: string;
  httpsEnabled: boolean;
}

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
  return normalizeHttpProxyWildcardDomain(wildcardDomain).slice(1);
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
  return hostname ? snapshot.routes.find((route) => route.hostname === hostname) ?? null : null;
}

export function isValidAsciiDnsName(value: string): boolean {
  if (value.length < 1 || value.length > 253 || value.includes('..')) return false;
  return value.split('.').every((label) => label.length >= 1
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export function httpProxyWarningMessage(reasons: HttpProxyWarningReason[]): string {
  const labels: Record<HttpProxyWarningReason, string> = {
    container_deleted: 'Container deleted',
    container_not_running: 'Container is not running',
    container_instance_missing: 'Incus instance identity is missing',
    container_stale: 'Container observation is stale',
    container_ip_missing: 'Routed IP is missing',
    domain_pool_disabled: 'Domain pool is disabled',
    https_not_configured: 'HTTPS certificate is not configured',
    route_missing: 'Proxy route is missing',
    proxy_offline: 'HTTP proxy is offline',
  };
  return reasons.map((reason) => labels[reason]).join(', ');
}
