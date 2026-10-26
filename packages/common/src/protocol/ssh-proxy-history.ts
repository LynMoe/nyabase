import { z } from 'zod';
import { onlyWithScopeAll, zIsoDateTime, zListScope, zUuid } from './rest-schema.js';

/**
 * SSH proxy connection history: the `history` frames a proxy sends, and the
 * REST surface that reads what the Backend stored from them.
 *
 * A proxy reports every authenticated connection and each of its channels as
 * a full record when it opens and again when it closes, so records can be
 * stored in any order and a later one repairs a lost one. Unauthenticated
 * connections are only counted per (address, reason) and window.
 */

const zAscii = (max: number) => z.string().min(1).max(max).regex(/^[\x20-\x7e]+$/);
/** Client-chosen text the proxy already cut to printable ASCII; may be empty. */
const zClientText = (max: number) => z.string().max(max).regex(/^[\x20-\x7e]*$/);
const zSafeCounter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const zCount32 = z.number().int().min(0).max(0xffff_ffff);
/** Close reasons, refusal reasons and request kinds: `snake_case` codes. */
/** An IPv4 or IPv6 address (zod 4 has no string().ip()). */
const zIpAddress = z.union([z.ipv4(), z.ipv6()]);

export const zSshHistoryCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/** Kinds of refused requests kept per connection (the proxy has about 15). */
export const MAX_SSH_REJECTED_REQUEST_KINDS = 64;
/** Records in one `history` frame; the proxy also bounds frames to 256 KiB. */
export const MAX_SSH_PROXY_HISTORY_RECORDS = 4_096;
/** (address, reason) pairs in one refusal window: the proxy keeps 256 plus one per reason. */
const MAX_SSH_PROXY_REFUSALS_PER_WINDOW = 512;

export const zSshProxyRouteRecord = z.object({
  serverId: zUuid,
  serverSlug: zAscii(64),
  containerId: zUuid,
  containerName: zAscii(64),
  instanceName: zAscii(63),
  routedIp: zClientText(15),
}).strict();

export const zSshProxyConnectionRecord = z.object({
  type: z.literal('connection'),
  seq: zSafeCounter,
  connectionSeq: zSafeCounter,
  peer: zAscii(128),
  clientVersion: zAscii(255).nullable(),
  login: zAscii(256),
  userId: zUuid,
  username: zAscii(64),
  keyFingerprint: zAscii(128),
  keyAlgorithm: zAscii(64),
  pinned: zSshProxyRouteRecord.nullable(),
  connectedAt: zSafeCounter,
  authenticatedAt: zSafeCounter,
  closedAt: zSafeCounter.nullable(),
  closeReason: zSshHistoryCode.nullable(),
  bytesFromClient: zSafeCounter,
  bytesToClient: zSafeCounter,
  channelsOpened: zCount32,
  channelsRejected: zCount32,
  // Only the codes that occurred are sent (a zod 4 record over an enum would demand every key).
  rejectedRequests: z.partialRecord(zSshHistoryCode, zCount32).refine(
    (value) => Object.keys(value).length <= MAX_SSH_REJECTED_REQUEST_KINDS,
    'too many rejected request kinds',
  ),
}).strict();

export const zSshProxyChannelRecord = z.object({
  type: z.literal('channel'),
  seq: zSafeCounter,
  connectionSeq: zSafeCounter,
  channelSeq: zCount32,
  targetHost: zClientText(255),
  targetPort: zCount32,
  originator: zClientText(128),
  route: zSshProxyRouteRecord.nullable(),
  /** `opened`, or why the channel was refused. */
  result: zSshHistoryCode,
  openedAt: zSafeCounter,
  closedAt: zSafeCounter.nullable(),
  closeReason: zSshHistoryCode.nullable(),
  bytesFromClient: zSafeCounter,
  bytesToClient: zSafeCounter,
}).strict();

export const zSshProxyRefusalsRecord = z.object({
  type: z.literal('refusals'),
  seq: zSafeCounter,
  windowStart: zSafeCounter,
  windowEnd: zSafeCounter,
  refusals: z.array(z.object({
    /** Null once the window already held the proxy's bound of distinct addresses. */
    peerIp: zIpAddress.nullable(),
    reason: zSshHistoryCode,
    count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict()).max(MAX_SSH_PROXY_REFUSALS_PER_WINDOW),
}).strict();

export const zSshProxyHistoryRecord = z.discriminatedUnion('type', [
  zSshProxyConnectionRecord,
  zSshProxyChannelRecord,
  zSshProxyRefusalsRecord,
]);

/**
 * One `history` frame. Records are validated one by one, so one malformed
 * record is skipped instead of holding back the rest; the Backend
 * acknowledges the highest `seq` of the frame once it stored it.
 */
export const zSshProxyHistoryFrame = z.object({
  proxyId: zAscii(128),
  instanceId: zAscii(64),
  records: z.array(z.unknown()).min(1).max(MAX_SSH_PROXY_HISTORY_RECORDS),
}).strict();

export const zSshProxyHistoryAck = z.object({
  seq: zSafeCounter,
}).strict();

export type SshProxyConnectionRecord = z.infer<typeof zSshProxyConnectionRecord>;
export type SshProxyChannelRecord = z.infer<typeof zSshProxyChannelRecord>;
export type SshProxyRefusalsRecord = z.infer<typeof zSshProxyRefusalsRecord>;
export type SshProxyHistoryRecord = z.infer<typeof zSshProxyHistoryRecord>;
export type SshProxyRouteRecord = z.infer<typeof zSshProxyRouteRecord>;

// --- REST ---------------------------------------------------------------------

export const MAX_SSH_SESSION_PAGE_SIZE = 200;
/** Detail and statistics windows reach at most this far back. */
export const MAX_SSH_SESSION_STATS_DAYS = 365;

/**
 * `GET /ssh-sessions`: your own connections by default; `scope=all` (operator)
 * lists everyone's and unlocks the `userId` / `serverId` filters.
 */
export const zSshSessionListQuery = z.object({
  scope: zListScope,
  limit: z.coerce.number().int().min(1).max(MAX_SSH_SESSION_PAGE_SIZE).optional(),
  cursor: z.string().min(1).max(512).optional(),
  userId: zUuid.optional(),
  serverId: zUuid.optional(),
  /** Connections that opened (or tried to open) a channel to this container, or are pinned to it. */
  containerId: zUuid.optional(),
  peerIp: zIpAddress.optional(),
  state: z.enum(['open', 'closed']).optional(),
  since: zIsoDateTime.optional(),
  until: zIsoDateTime.optional(),
}).strict().superRefine(onlyWithScopeAll('userId', 'serverId'));

export const zSshSessionStatsQuery = z.object({
  scope: zListScope,
  days: z.coerce.number().int().min(1).max(MAX_SSH_SESSION_STATS_DAYS).default(30),
  userId: zUuid.optional(),
  containerId: zUuid.optional(),
}).strict().superRefine(onlyWithScopeAll('userId'));

export const zSshProxyRefusalsQuery = z.object({
  hours: z.coerce.number().int().min(1).max(MAX_SSH_SESSION_STATS_DAYS * 24).default(24),
}).strict();

export type SshSessionListQuery = z.infer<typeof zSshSessionListQuery>;
export type SshSessionStatsQuery = z.infer<typeof zSshSessionStatsQuery>;

export interface SshSessionRouteDto {
  serverId: string;
  serverSlug: string;
  containerId: string;
  containerName: string;
}

export interface SshSessionDto {
  id: string;
  proxyId: string;
  /** `address:port` the client connected from. */
  peer: string;
  peerIp: string;
  clientVersion: string | null;
  login: string;
  userId: string;
  username: string;
  keyFingerprint: string;
  keyAlgorithm: string;
  /** The container named by a `user.server.container` login, if any. */
  pinned: SshSessionRouteDto | null;
  connectedAt: string;
  authenticatedAt: string;
  /** Null while the connection is open. */
  closedAt: string | null;
  closeReason: string | null;
  /** Last time the proxy reported this connection (byte counts are as of then). */
  lastSeenAt: string;
  bytesFromClient: number;
  bytesToClient: number;
  channelsOpened: number;
  channelsRejected: number;
  /** Refused requests by kind: channel results (`rejected_permit`, …) and other requests (`session`, `remote_forward`, …). */
  rejectedRequests: Record<string, number>;
  /** Distinct containers this connection opened channels to. */
  targets: SshSessionRouteDto[];
}

export interface SshSessionChannelDto {
  seq: number;
  /** The `direct-tcpip` target as the client sent it. */
  targetHost: string;
  targetPort: number;
  originator: string;
  route: (SshSessionRouteDto & { instanceName: string; routedIp: string }) | null;
  /** `opened`, or why it was refused. */
  result: string;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  bytesFromClient: number;
  bytesToClient: number;
}

export interface SshSessionDetailDto extends SshSessionDto {
  channels: SshSessionChannelDto[];
  /** Refused channels beyond the ones recorded one by one. */
  unrecordedRejectedChannels: number;
}

export interface SshSessionDailyUsageDto {
  /** `YYYY-MM-DD` (UTC). */
  day: string;
  connections: number;
  channels: number;
  bytesFromClient: number;
  bytesToClient: number;
}

export interface SshSessionStatsDto {
  days: number;
  since: string;
  totals: Omit<SshSessionDailyUsageDto, 'day'> & { users: number; containers: number };
  daily: SshSessionDailyUsageDto[];
  topUsers: Array<{ userId: string; username: string; connections: number; bytes: number }>;
  topContainers: Array<SshSessionRouteDto & { channels: number; bytes: number }>;
  /** From connections still within the detail retention only. */
  closeReasons: Record<string, number>;
  /** From connections still within the detail retention only. */
  rejectedRequests: Record<string, number>;
}

export interface SshProxyRefusalsDto {
  hours: number;
  total: number;
  reasons: Record<string, number>;
  /** Largest (address, reason) totals over the window, at most 200. */
  topSources: Array<{ peerIp: string | null; reason: string; count: number; lastSeenAt: string }>;
  /** Hourly totals over the window. */
  hourly: Array<{ hour: string; count: number }>;
}
