import { z } from 'zod';
import { ContainerStatus, UserStatus } from '../enums.js';
import {
  SSH_PROXY_SNAPSHOT_STALE_MAX_MS,
  SSH_PROXY_SNAPSHOT_STALE_MIN_MS,
  MAX_PLATFORM_ACTIVE_USERS,
  MAX_PLATFORM_SERVERS,
  MAX_PLATFORM_IMAGES,
  MAX_SSH_PUBLIC_KEYS_PER_USER,
  MAX_SSH_PUBLIC_KEY_TEXT_LENGTH,
  MAX_SSH_PROXY_CONTAINERS,
  MAX_SSH_PROXY_STATUS_CONNECTIONS,
  PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
} from '../constants.js';

const zAscii = (max: number) => z.string().min(1).max(max).regex(/^[\x20-\x7e]+$/);
const zAsciiText = (max: number) => z.string().min(1).max(max)
  .regex(/^[\x09\x0a\x0d\x20-\x7e]+$/);
// All proxy identities are generated UUIDs. Keeping a small ASCII-only wire
// domain prevents Zod's UTF-16 length accounting from underestimating the
// actual UTF-8 WebSocket frame size.
const zId = zAscii(64);
const zSafeCounter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const zProxyTimestampMs = zSafeCounter.refine(
  (value) => value <= Date.now() + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
  'Proxy timestamp exceeds the allowed clock-skew window',
);

export const zSshProxyEndpoint = z.object({
  host: zAscii(253),
  port: z.number().int().min(1).max(65535),
}).strict();

export const zSshProxyHostKey = z.object({
  privateKey: zAsciiText(16 * 1024),
  publicKey: zAsciiText(4 * 1024),
  fingerprint: zAscii(128),
  generation: z.number().int().nonnegative(),
}).strict();

export const zSshProxyUserSnapshot = z.object({
  id: zId,
  username: zAscii(64),
  status: z.nativeEnum(UserStatus),
  publicKeys: z.array(zAsciiText(MAX_SSH_PUBLIC_KEY_TEXT_LENGTH))
    .max(MAX_SSH_PUBLIC_KEYS_PER_USER),
  internalPrivateKey: zAsciiText(4 * 1024),
  internalPublicKey: zAsciiText(2 * 1024),
  internalKeyFingerprint: zAscii(128),
  internalKeyGeneration: z.number().int().nonnegative(),
}).strict();

export const zSshProxyServerSnapshot = z.object({
  id: zId,
  slug: zAscii(64),
  name: z.string().min(1).max(128),
  online: z.boolean(),
}).strict();

export const zSshProxyImageSnapshot = z.object({
  id: zId,
  disableSsh: z.boolean(),
}).strict();

export const zSshProxyContainerSnapshot = z.object({
  id: zId,
  ownerId: zId,
  serverId: zId,
  imageId: zId,
  name: zAscii(64),
}).strict();

export const zSshProxyRuntimeRouteSnapshot = z.object({
  containerId: zId,
  serverId: zId,
  runtimeId: zAscii(128),
  macvlanIp: zAscii(15).nullable(),
  runtimeStatus: z.nativeEnum(ContainerStatus),
  sshStatus: z.enum(['disabled', 'container_stopped', 'running', 'error', 'unknown']),
  appliedInternalKeyGeneration: z.number().int().nonnegative().nullable(),
  containerHostKeyFingerprint: zAscii(128).nullable(),
  observedAt: zAscii(64),
}).strict();

export const zSshProxySnapshot = z.object({
  generation: z.number().int().nonnegative(),
  createdAt: z.string().min(1).max(64),
  staleAfterMs: z.number().int()
    .min(SSH_PROXY_SNAPSHOT_STALE_MIN_MS)
    .max(SSH_PROXY_SNAPSHOT_STALE_MAX_MS),
  validUntil: z.number().int().positive(),
  endpoint: zSshProxyEndpoint.nullable(),
  hostKey: zSshProxyHostKey,
  users: z.array(zSshProxyUserSnapshot).max(MAX_PLATFORM_ACTIVE_USERS),
  servers: z.array(zSshProxyServerSnapshot).max(MAX_PLATFORM_SERVERS),
  images: z.array(zSshProxyImageSnapshot).max(MAX_PLATFORM_IMAGES),
  containers: z.array(zSshProxyContainerSnapshot).max(MAX_SSH_PROXY_CONTAINERS),
  routes: z.array(zSshProxyRuntimeRouteSnapshot).max(MAX_SSH_PROXY_CONTAINERS),
}).strict();

export const zSshProxyClientAck = z.object({
  generation: z.number().int().nonnegative(),
});

export const zSshProxyMetric = z.object({
  name: z.string(),
  labels: z.record(z.string()),
  value: z.number(),
  ts: z.number(),
});

export const zSshProxyAuditEvent = z.object({
  userId: z.string().optional(),
  username: z.string().optional(),
  containerId: z.string().optional(),
  serverId: z.string().optional(),
  action: z.string(),
  ok: z.boolean(),
  reason: z.string().optional(),
  ts: z.number(),
});

export const zSshProxyConnectionInfo = z.object({
  id: zAscii(64),
  peer: zAscii(128),
  username: zAscii(64).nullable(),
  login: zAscii(256).nullable(),
  serverSlug: zAscii(64).nullable(),
  serverId: zId.nullable(),
  containerName: zAscii(64).nullable(),
  containerId: zId.nullable(),
  runtimeId: zAscii(128).nullable(),
  connectedAt: zProxyTimestampMs,
  authenticatedAt: zProxyTimestampMs.nullable(),
  bytesFromClient: zSafeCounter,
  bytesToClient: zSafeCounter,
  channels: z.number().int().min(0).max(16),
}).strict();

export const zSshProxyStatusReport = z.object({
  proxyId: zAscii(128),
  hostname: zAscii(253).nullable(),
  listen: zAscii(128),
  uptimeMs: zSafeCounter,
  connectedAt: zProxyTimestampMs,
  lastSnapshotGeneration: zSafeCounter.nullable(),
  lastSnapshotAt: zProxyTimestampMs.nullable(),
  activeConnections: z.number().int().min(0).max(MAX_SSH_PROXY_STATUS_CONNECTIONS),
  totalConnections: zSafeCounter,
  totalRejectedConnections: zSafeCounter,
  totalClosedConnections: zSafeCounter,
  totalBytesFromClient: zSafeCounter,
  totalBytesToClient: zSafeCounter,
  bandwidthInBps: z.number().min(0).max(Number.MAX_SAFE_INTEGER),
  bandwidthOutBps: z.number().min(0).max(Number.MAX_SAFE_INTEGER),
  connections: z.array(zSshProxyConnectionInfo).max(MAX_SSH_PROXY_STATUS_CONNECTIONS),
}).strict().superRefine((status, context) => {
  if (status.activeConnections !== status.connections.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['activeConnections'],
      message: 'activeConnections must equal the bounded connection detail count',
    });
  }
});

export const zSshProxyDisconnectAllCommand = z.object({
  // Backend-generated 96-bit correlation id. Exact syntax prevents an
  // authenticated peer from manufacturing attacker-sized pending-map probes.
  requestId: z.string().length(24).regex(/^[a-f0-9]{24}$/),
  reason: zAsciiText(512).optional(),
}).strict();

export const zSshProxyDisconnectAllResult = z.object({
  requestId: z.string().length(24).regex(/^[a-f0-9]{24}$/),
  // One standalone proxy cannot own more sessions than its configured hard
  // cap. This also makes aggregation across the bounded proxy client set safe.
  disconnected: z.number().int().min(0).max(MAX_SSH_PROXY_STATUS_CONNECTIONS),
}).strict();

export type SshProxyEndpoint = z.infer<typeof zSshProxyEndpoint>;
export type SshProxyHostKey = z.infer<typeof zSshProxyHostKey>;
export type SshProxyUserSnapshot = z.infer<typeof zSshProxyUserSnapshot>;
export type SshProxyServerSnapshot = z.infer<typeof zSshProxyServerSnapshot>;
export type SshProxyImageSnapshot = z.infer<typeof zSshProxyImageSnapshot>;
export type SshProxyContainerSnapshot = z.infer<typeof zSshProxyContainerSnapshot>;
export type SshProxyRuntimeRouteSnapshot = z.infer<typeof zSshProxyRuntimeRouteSnapshot>;
export type SshProxySnapshot = z.infer<typeof zSshProxySnapshot>;
export type SshProxyClientAck = z.infer<typeof zSshProxyClientAck>;
export type SshProxyMetric = z.infer<typeof zSshProxyMetric>;
export type SshProxyAuditEvent = z.infer<typeof zSshProxyAuditEvent>;
export type SshProxyConnectionInfo = z.infer<typeof zSshProxyConnectionInfo>;
export type SshProxyStatusReport = z.infer<typeof zSshProxyStatusReport>;
export type SshProxyDisconnectAllCommand = z.infer<typeof zSshProxyDisconnectAllCommand>;
export type SshProxyDisconnectAllResult = z.infer<typeof zSshProxyDisconnectAllResult>;

export type SshProxyBackendMessage =
  | { kind: 'snapshot'; payload: SshProxySnapshot }
  | { kind: 'update'; payload: SshProxySnapshot }
  | { kind: 'disconnectAll'; payload: SshProxyDisconnectAllCommand };

export type SshProxyClientMessage =
  | { kind: 'ack'; payload: SshProxyClientAck }
  | { kind: 'metrics'; payload: { metrics: SshProxyMetric[] } }
  | { kind: 'audit'; payload: SshProxyAuditEvent }
  | { kind: 'status'; payload: SshProxyStatusReport }
  | { kind: 'disconnectAllResult'; payload: SshProxyDisconnectAllResult };

export interface ParsedSshProxyLogin {
  username: string;
  serverSlug: string | null;
  containerName: string;
}

export type SshProxyRouteResolution =
  | {
    ok: true;
    login: ParsedSshProxyLogin;
    user: SshProxyUserSnapshot;
    server: SshProxyServerSnapshot;
    container: SshProxyContainerSnapshot;
    route: SshProxyRuntimeRouteSnapshot;
  }
  | {
    ok: false;
    login: ParsedSshProxyLogin | null;
    reason: 'invalid_login' | 'user_not_found' | 'user_disabled' | 'server_not_found' | 'route_not_found' | 'ambiguous_container';
    candidates?: Array<{ serverSlug: string; containerName: string }>;
  };

export function parseSshProxyLogin(value: string): ParsedSshProxyLogin | null {
  const parts = value.trim().toLowerCase().split('.').filter((part) => part.length > 0);
  if (parts.length === 2) {
    return { username: parts[0], serverSlug: null, containerName: parts[1] };
  }
  if (parts.length === 3) {
    return { username: parts[0], serverSlug: parts[1], containerName: parts[2] };
  }
  return null;
}

export function resolveSshProxyRoute(
  snapshot: Pick<SshProxySnapshot, 'users' | 'servers' | 'images' | 'containers' | 'routes'>,
  loginValue: string,
): SshProxyRouteResolution {
  const login = parseSshProxyLogin(loginValue);
  if (!login) return { ok: false, login, reason: 'invalid_login' };

  const user = snapshot.users.find((row) => row.username.toLowerCase() === login.username);
  if (!user) return { ok: false, login, reason: 'user_not_found' };
  if (user.status !== UserStatus.Active) return { ok: false, login, reason: 'user_disabled' };

  const serversById = new Map(snapshot.servers.map((row) => [row.id, row]));
  const imagesById = new Map(snapshot.images.map((row) => [row.id, row]));
  const routesByContainerId = new Map(snapshot.routes.map((row) => [row.containerId, row]));

  const active = snapshot.containers
    .filter((container) => container.ownerId === user.id)
    .filter((container) => container.name.toLowerCase() === login.containerName)
    .filter((container) => imagesById.get(container.imageId)?.disableSsh !== true)
    .map((container) => {
      const server = serversById.get(container.serverId);
      const route = routesByContainerId.get(container.id);
      return server
        && server.online
        && route
        && route.serverId === container.serverId
        && isActiveSshProxyRoute(route)
        ? { container, server, route }
        : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const candidates = login.serverSlug
    ? active.filter((entry) => entry.server.slug.toLowerCase() === login.serverSlug)
    : active;

  if (login.serverSlug && !snapshot.servers.some((row) => row.slug.toLowerCase() === login.serverSlug)) {
    return { ok: false, login, reason: 'server_not_found' };
  }
  if (candidates.length === 0) return { ok: false, login, reason: 'route_not_found' };
  if (!login.serverSlug && candidates.length > 1) {
    return {
      ok: false,
      login,
      reason: 'ambiguous_container',
      candidates: candidates.map((entry) => ({
        serverSlug: entry.server.slug,
        containerName: entry.container.name,
      })),
    };
  }

  const selected = candidates[0];
  return {
    ok: true,
    login,
    user,
    server: selected.server,
    container: selected.container,
    route: selected.route,
  };
}

export function isActiveSshProxyRoute(route: SshProxyRuntimeRouteSnapshot): boolean {
  return Boolean(route.macvlanIp)
    && route.runtimeStatus === ContainerStatus.Running
    && route.sshStatus === 'running';
}
