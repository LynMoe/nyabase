import { z } from 'zod';
import { ContainerStatus, ServerStatus, UserStatus } from '../enums.js';
import {
  MAX_PLATFORM_ACTIVE_USERS,
  MAX_PLATFORM_IMAGES,
  MAX_PLATFORM_SERVERS,
  MAX_SSH_PUBLIC_KEYS_PER_USER,
  MAX_SSH_PUBLIC_KEY_TEXT_LENGTH,
  MAX_SSH_PROXY_CONTAINERS,
  MAX_SSH_PROXY_STATUS_CONNECTIONS,
  PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
  SSH_PROXY_SNAPSHOT_STALE_MAX_MS,
  SSH_PROXY_SNAPSHOT_STALE_MIN_MS,
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

export const zSshProxyEndpoint = z.object({
  host: zAscii(253),
  port: z.number().int().min(1).max(65_535),
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
}).strict();

export const zSshProxyServerSnapshot = z.object({
  id: zId,
  slug: zAscii(64),
  name: z.string().min(1).max(128),
  status: z.nativeEnum(ServerStatus),
}).strict();

export const zSshProxyImageSnapshot = z.object({
  id: zId,
  sshEnabled: z.boolean(),
}).strict();

export const zSshProxyContainerSnapshot = z.object({
  id: zId,
  ownerId: zId,
  serverId: zId,
  imageId: zId,
  name: zAscii(64),
  instanceName: zAscii(63),
}).strict();

export const zSshProxyInstanceRouteSnapshot = z.object({
  containerId: zId,
  serverId: zId,
  instanceName: zAscii(63),
  routedIp: zAscii(15).nullable(),
  status: z.nativeEnum(ContainerStatus),
  sshStatus: z.enum(['disabled', 'container_stopped', 'running', 'error', 'unknown']),
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
  routes: z.array(zSshProxyInstanceRouteSnapshot).max(MAX_SSH_PROXY_CONTAINERS),
}).strict();

export const zSshProxyClientAck = z.object({
  generation: z.number().int().nonnegative(),
}).strict();

export const zSshProxyMetric = z.object({
  name: z.string().min(1).max(128),
  labels: z.record(z.string()),
  value: z.number().finite(),
  ts: z.number().finite(),
}).strict();

export const zSshProxyAuditEvent = z.object({
  userId: z.string().optional(),
  username: z.string().optional(),
  containerId: z.string().optional(),
  serverId: z.string().optional(),
  action: z.string().min(1).max(128),
  ok: z.boolean(),
  reason: z.string().optional(),
  ts: z.number().finite(),
}).strict();

export const zSshProxyConnectionInfo = z.object({
  id: zAscii(64),
  peer: zAscii(128),
  username: zAscii(64).nullable(),
  login: zAscii(256).nullable(),
  serverSlug: zAscii(64).nullable(),
  serverId: zId.nullable(),
  containerName: zAscii(64).nullable(),
  containerId: zId.nullable(),
  instanceName: zAscii(63).nullable(),
  routedIp: zAscii(15).nullable(),
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
  requestId: z.string().length(24).regex(/^[a-f0-9]{24}$/),
  reason: zAsciiText(512).optional(),
}).strict();

export const zSshProxyPauseAdmitCommand = z.object({
  reason: zAsciiText(512).optional(),
}).strict();

export const zSshProxyDisconnectAllResult = z.object({
  requestId: z.string().length(24).regex(/^[a-f0-9]{24}$/),
  disconnected: z.number().int().min(0).max(MAX_SSH_PROXY_STATUS_CONNECTIONS),
}).strict();

export type SshProxyEndpoint = z.infer<typeof zSshProxyEndpoint>;
export type SshProxyHostKey = z.infer<typeof zSshProxyHostKey>;
export type SshProxyInstanceRouteSnapshot = z.infer<typeof zSshProxyInstanceRouteSnapshot>;
export type SshProxySnapshot = z.infer<typeof zSshProxySnapshot>;
export type SshProxyStatusReport = z.infer<typeof zSshProxyStatusReport>;
export type SshProxyDisconnectAllCommand = z.infer<typeof zSshProxyDisconnectAllCommand>;
export type SshProxyPauseAdmitCommand = z.infer<typeof zSshProxyPauseAdmitCommand>;

export type SshProxyBackendMessage =
  | { kind: 'snapshot'; payload: SshProxySnapshot }
  | { kind: 'update'; payload: SshProxySnapshot }
  | { kind: 'disconnectAll'; payload: SshProxyDisconnectAllCommand }
  | { kind: 'pauseAdmit'; payload: SshProxyPauseAdmitCommand };

/** Jump destination helpers for client UX (ProxyJump). */
export function formatSshProxyJumpLogin(input: {
  username: string;
  containerName: string;
  serverSlug?: string | null;
}): string {
  const username = input.username.trim().toLowerCase();
  const containerName = input.containerName.trim().toLowerCase();
  const serverSlug = input.serverSlug?.trim().toLowerCase() || null;
  return serverSlug
    ? `${username}.${serverSlug}.${containerName}`
    : `${username}.${containerName}`;
}
