import { z } from 'zod';
import { ContainerStatus, ServerStatus, UserStatus } from '../enums.js';
import { visibleNameProblem } from '../display-name.js';
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
  hostKey: zSshProxyHostKey,
  hostSuffix: zAscii(200),
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
  labels: z.record(z.string(), z.string()),
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

/** One live `direct-tcpip` bridge of a connection. */
export const zSshProxyBridgeInfo = z.object({
  channelSeq: z.number().int().min(0).max(0xffff_ffff),
  serverId: zId,
  serverSlug: zAscii(64),
  containerId: zId,
  containerName: zAscii(64),
  routedIp: z.string().max(15).regex(/^[\x20-\x7e]*$/),
  openedAt: zProxyTimestampMs,
  bytesFromClient: zSafeCounter,
  bytesToClient: zSafeCounter,
}).strict();

export const zSshProxyConnectionInfo = z.object({
  id: zAscii(64),
  /** The connection's sequence number in this proxy instance's history. */
  seq: zSafeCounter.optional(),
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
  /** Each live bridge: one connection can reach several containers. */
  bridges: z.array(zSshProxyBridgeInfo).max(16).optional(),
}).strict();

export const zSshProxyStatusReport = z.object({
  proxyId: zAscii(128),
  /** Random per proxy process; older proxies omit it (and send no history). */
  instanceId: zAscii(64).optional(),
  /** History records the Backend has not acknowledged yet. */
  historyBacklog: z.number().int().min(0).max(1_000_000).optional(),
  /** History records the proxy dropped because its backlog was full. */
  historyDropped: zSafeCounter.optional(),
  hostname: zAscii(253).nullable(),
  listen: zAscii(128),
  uptimeMs: zSafeCounter,
  connectedAt: zProxyTimestampMs,
  lastSnapshotGeneration: zSafeCounter.nullable(),
  lastSnapshotAt: zProxyTimestampMs.nullable(),
  activeConnections: z.number().int().min(0).max(MAX_SSH_PROXY_STATUS_CONNECTIONS),
  /** Connections counted in activeConnections whose details were left out to bound the frame. */
  omittedConnections: z.number().int().min(0).max(MAX_SSH_PROXY_STATUS_CONNECTIONS),
  totalConnections: zSafeCounter,
  totalRejectedConnections: zSafeCounter,
  totalClosedConnections: zSafeCounter,
  totalBytesFromClient: zSafeCounter,
  totalBytesToClient: zSafeCounter,
  bandwidthInBps: z.number().min(0).max(Number.MAX_SAFE_INTEGER),
  bandwidthOutBps: z.number().min(0).max(Number.MAX_SAFE_INTEGER),
  connections: z.array(zSshProxyConnectionInfo).max(MAX_SSH_PROXY_STATUS_CONNECTIONS),
}).strict().superRefine((status, context) => {
  if (status.activeConnections !== status.connections.length + status.omittedConnections) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['activeConnections'],
      message: 'activeConnections must equal the connection detail count plus omittedConnections',
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
  | { kind: 'pauseAdmit'; payload: SshProxyPauseAdmitCommand }
  | { kind: 'historyAck'; payload: { seq: number } };

// --- client configuration (ProxyJump) -------------------------------------------

/** `work.nya`: how a container is addressed through the SSH proxy. */
export function sshContainerHostName(containerName: string, hostSuffix: string): string {
  const name = containerName.trim().toLowerCase();
  const suffix = hostSuffix.trim().toLowerCase();
  return suffix ? `${name}.${suffix}` : name;
}

/**
 * `alice@ssh.example.com:2222` (no port for 22). The proxy authenticates by
 * key alone; the login only labels the session in audit and status.
 */
export function formatSshProxyJump(input: { username: string; host: string; port: number }): string {
  return `${input.username}@${formatSshAddress(input)}`;
}

/** `ssh.example.com:2222`, `[2001:db8::1]:2222`; no port for 22. */
export function formatSshAddress(input: { host: string; port: number }): string {
  const host = input.host.includes(':') ? `[${input.host}]` : input.host;
  return `${host}${input.port === 22 ? '' : `:${input.port}`}`;
}

/**
 * `ssh -J` to one container without the client config: the login user is
 * named, and the full host name keeps the container's host certificate valid.
 */
export function formatSshJumpCommand(input: {
  username: string;
  host: string;
  port: number;
  loginUser: string;
  hostName: string;
}): string {
  return `ssh -J ${formatSshProxyJump(input)} ${input.loginUser}@${input.hostName}`;
}

/** One `~/.ssh/config` block that reaches every one of the user's containers by name. */
export function formatSshClientConfig(input: {
  username: string;
  host: string;
  port: number;
  hostSuffix: string;
}): string {
  return [
    `Host *.${input.hostSuffix}`,
    '  User root',
    `  ProxyJump ${formatSshProxyJump(input)}`,
  ].join('\n');
}

/**
 * The one-time client setup as a request to an AI agent on the user's
 * machine: a short instruction, then the ssh_config block and the
 * known_hosts lines verbatim, and a non-interactive login to check it.
 */
export function formatSshAgentSetupPrompt(input: {
  sshConfig: string;
  knownHosts: string;
  hostSuffix: string;
  /** `[user@]host` to try once the setup is in place. */
  verifyTarget: string;
}): string {
  return [
    '帮我把下面的 SSH 配置配置到本机，不要改动其他已有条目：',
    '',
    `1. 把这段加到 ~/.ssh/config，放在任何 \`Host *\` 段之前；已有 \`Host *.${input.hostSuffix}\` 段就替换它：`,
    '',
    input.sshConfig,
    '',
    `2. 把这几行加到 ~/.ssh/known_hosts；已有同一主机或 \`*.${input.hostSuffix}\` 的旧行就替换：`,
    '',
    input.knownHosts,
    '',
    `3. 运行 \`ssh -o BatchMode=yes ${input.verifyTarget} true\` 验证能直接登录，不应出现主机指纹确认。`,
  ].join('\n');
}

/**
 * `~/.ssh/known_hosts` lines: the proxy's own host key under every line's
 * address, and the user's host certificate authority for every container
 * name under the suffix.
 */
export function formatSshKnownHosts(input: {
  endpoints: ReadonlyArray<{ host: string; port: number }>;
  hostSuffix: string;
  proxyHostKey: string;
  hostCertificateAuthority: string | null;
}): string {
  const keyOnly = (text: string) => text.trim().split(/\s+/).slice(0, 2).join(' ');
  const hosts = new Set(input.endpoints.map(({ host, port }) => (port === 22 ? host : `[${host}]:${port}`)));
  const lines = [...hosts].map((host) => `${host} ${keyOnly(input.proxyHostKey)}`);
  if (input.hostCertificateAuthority) {
    lines.push(`@cert-authority *.${input.hostSuffix} ${keyOnly(input.hostCertificateAuthority)}`);
  }
  return lines.join('\n');
}

// --- connection lines ------------------------------------------------------------

/**
 * Public addresses of the same SSH proxy (a campus network, a region, a
 * relay). Every container's SSH card shows one `ssh -J` tab per line, in the
 * administrators' order; the first is the default for the one-time setup.
 */
export const MAX_SSH_PROXY_LINES = 16;
/** Terminal columns a line name may take (a CJK character takes two). */
export const SSH_PROXY_LINE_NAME_MAX_WIDTH = 16;
export const SSH_PROXY_LINE_HINT_MAX_LENGTH = 80;

const SSH_HOST_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const SSH_DNS_NAME_RE = new RegExp(`^${SSH_HOST_LABEL}(?:\\.${SSH_HOST_LABEL})*$`);
const SSH_IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * A line's host in canonical form (lower-case name, dotted IPv4, compressed
 * IPv6), or null. Anything with a colon must be a whole IPv6 address, so a
 * port typed into the host (`1.2.3.4:22`) is refused; an all-numeric dotted
 * name must be a valid IPv4 address.
 */
function canonicalSshProxyHost(value: string): string | null {
  if (value.includes(':')) {
    if (!/^[0-9A-Fa-f:.]+$/.test(value)) return null;
    try {
      return new URL(`http://[${value}]/`).hostname.slice(1, -1);
    } catch {
      return null;
    }
  }
  if (/^[0-9.]+$/.test(value)) return SSH_IPV4_RE.test(value) ? value : null;
  return SSH_DNS_NAME_RE.test(value) ? value.toLowerCase() : null;
}

const zSshProxyLineName = z.string().trim().max(64).transform((value) => value.normalize('NFC')).superRefine((value, context) => {
  const problem = visibleNameProblem(value, 'Line name', SSH_PROXY_LINE_NAME_MAX_WIDTH);
  if (problem) context.addIssue({ code: z.ZodIssueCode.custom, message: problem });
});
const zSshProxyLineHost = z.string().trim().min(1).max(253).transform((value, context) => {
  const host = canonicalSshProxyHost(value);
  if (host === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Host must be a DNS name or an IP address, without a port' });
    return z.NEVER;
  }
  return host;
});
const zSshProxyLinePort = z.number().int().min(1).max(65_535);
/** Shown with the line's tab; blank means none. */
const zSshProxyLineHint = z.string().trim().max(SSH_PROXY_LINE_HINT_MAX_LENGTH)
  .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u, 'Hint must be a single line of visible text')
  .nullable()
  .transform((value) => value || null);

export const zCreateSshProxyLineRequest = z.object({
  name: zSshProxyLineName,
  host: zSshProxyLineHost,
  port: zSshProxyLinePort,
  hint: zSshProxyLineHint.default(null),
}).strict();

export const zPatchSshProxyLineRequest = z.object({
  name: zSshProxyLineName.optional(),
  host: zSshProxyLineHost.optional(),
  port: zSshProxyLinePort.optional(),
  hint: zSshProxyLineHint.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one line field is required');

/** Every line's id exactly once, in the new order. */
export const zReorderSshProxyLinesRequest = z.object({
  ids: z.array(z.string().uuid()).min(1).max(MAX_SSH_PROXY_LINES),
}).strict();

export type CreateSshProxyLineRequest = z.infer<typeof zCreateSshProxyLineRequest>;
export type PatchSshProxyLineRequest = z.infer<typeof zPatchSshProxyLineRequest>;
export type ReorderSshProxyLinesRequest = z.infer<typeof zReorderSshProxyLinesRequest>;

export interface SshProxyLineDto {
  id: string;
  name: string;
  host: string;
  port: number;
  hint: string | null;
}
