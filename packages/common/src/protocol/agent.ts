import { z } from 'zod';

/*
 * Host agent <-> Backend protocol. The agent always dials the Backend: one
 * control WebSocket carries hello / request / response frames, and every
 * Incus WebSocket the Backend needs (events, exec) is a separate stream
 * WebSocket the agent opens back to the Backend on request.
 */

/**
 * The contract between a Backend build and an agent build: the frame shapes
 * here AND what the agent's policy (packages/agent/src/policy.ts) accepts.
 * Bump it whenever either changes so that one side's output could be refused
 * by the other; the Backend closes a control socket that says hello with any
 * other version (AGENT_CLOSE_PROTOCOL_UNSUPPORTED) and records why on the
 * server. packages/agent/src/protocol-freeze.test.ts pins the sources.
 */
export const AGENT_PROTOCOL_VERSION = 2;
export const AGENT_CONTROL_PATH = '/ws/agent';
export const AGENT_STREAM_PATH = '/ws/agent/stream';
export const AGENT_ENROLL_PATH = '/api/agent/enroll';

/** Close code for a hello whose protocol the Backend does not speak. */
export const AGENT_CLOSE_PROTOCOL_UNSUPPORTED = 4426;

export const AGENT_ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1000;
export const AGENT_HEARTBEAT_INTERVAL_MS = 15_000;
export const AGENT_STREAM_CONNECT_TIMEOUT_MS = 15_000;
/** Largest Incus request or response body carried through the tunnel. */
export const MAX_AGENT_INCUS_BODY_BYTES = 16 * 1024 * 1024;
/** Control frames carry base64 bodies; leave room for the 4/3 expansion. */
export const MAX_AGENT_CONTROL_FRAME_BYTES = 24 * 1024 * 1024;
export const MAX_AGENT_STREAM_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_AGENT_METRICS_TEXT_BYTES = 8 * 1024 * 1024;

/** Host-side veth names of managed NICs; the agent's IPv6 guard matches this prefix. */
export const MANAGED_NIC_HOST_NAME_PREFIX = 'nyh';
export const MANAGED_NIC_HOST_NAME_PATTERN = /^nyh[0-9a-f]{12}$/;
export const MANAGED_INSTANCE_NAME_PATTERN = /^nyc-[0-9a-f]{32}$/;
export const MANAGED_VOLUME_NAME_PATTERN = /^nyv-[0-9a-f]{32}$/;
export const MANAGED_ATTACHMENT_DEVICE_PATTERN = /^nyd-[0-9a-f]{32}$/;
/** The nft table the agent keeps on every host to drop guest IPv6. */
export const AGENT_IPV6_GUARD_TABLE = 'nyabase_guard';
/** Instance sysctls the platform sets to disable guest IPv6. */
export const GUEST_IPV6_DISABLE_SYSCTLS = [
  'linux.sysctl.net.ipv6.conf.all.disable_ipv6',
  'linux.sysctl.net.ipv6.conf.default.disable_ipv6',
] as const;

export type AgentSecretKind = 'credential' | 'enrollment';
const AGENT_SECRET_PREFIX: Readonly<Record<AgentSecretKind, string>> = {
  credential: 'nyak',
  enrollment: 'nyae',
};
const AGENT_SECRET_PATTERN = /^(nyak|nyae)\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;

/** `<prefix>.<server id without dashes>.<32 random bytes, base64url>` */
export function formatAgentSecret(kind: AgentSecretKind, serverId: string, secret: string): string {
  return `${AGENT_SECRET_PREFIX[kind]}.${serverId.replaceAll('-', '').toLowerCase()}.${secret}`;
}

/** The server id a well-formed agent secret names, or null. */
export function parseAgentSecret(
  kind: AgentSecretKind,
  value: string,
): { readonly serverId: string } | null {
  const match = AGENT_SECRET_PATTERN.exec(value.trim());
  if (!match || match[1] !== AGENT_SECRET_PREFIX[kind]) return null;
  const hex = match[2]!;
  return {
    serverId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  };
}

const zRequestId = z.string().regex(/^[0-9a-f-]{1,64}$/);
const zText = (max: number) => z.string().min(1).max(max);

export const zAgentEnrollRequest = z.object({
  enrollmentToken: zText(256),
  hostname: zText(253),
}).strict();

export const zAgentEnrollResponse = z.object({
  serverId: z.string().uuid(),
  credential: zText(256),
}).strict();

export const zAgentHello = z.object({
  type: z.literal('hello'),
  protocol: z.literal(AGENT_PROTOCOL_VERSION),
  agentVersion: zText(64),
  hostname: zText(253),
  incus: z.object({
    serverVersion: zText(64),
    apiExtensions: z.array(zText(128)).max(2048),
  }).strict(),
}).strict();

export const zAgentWelcome = z.object({
  type: z.literal('welcome'),
  serverId: z.string().uuid(),
}).strict();

export const INCUS_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type AgentIncusHttpMethod = typeof INCUS_HTTP_METHODS[number];

export const zAgentIncusHttpParams = z.object({
  method: z.enum(INCUS_HTTP_METHODS),
  path: zText(4096).regex(/^\/1\.0(?:[/?].*)?$/),
  headers: z.record(zText(256), z.string().max(4096)).optional(),
  /** Request body, base64 encoded. */
  body: z.string().max(Math.ceil(MAX_AGENT_INCUS_BODY_BYTES / 3) * 4 + 4).optional(),
  timeoutMs: z.number().int().positive().max(600_000),
}).strict();

export const zAgentIncusHttpResult = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()),
  /** Response body, base64 encoded. */
  body: z.string(),
}).strict();

export const zAgentIncusWebSocketParams = z.object({
  path: zText(4096).regex(/^\/1\.0\//),
  streamId: z.string().uuid(),
}).strict();

export const zAgentMetricsResult = z.object({
  text: z.string().max(MAX_AGENT_METRICS_TEXT_BYTES),
}).strict();

export const zAgentRequest = z.discriminatedUnion('method', [
  z.object({
    type: z.literal('request'),
    id: zRequestId,
    method: z.literal('incus.http'),
    params: zAgentIncusHttpParams,
  }).strict(),
  z.object({
    type: z.literal('request'),
    id: zRequestId,
    method: z.literal('incus.ws'),
    params: zAgentIncusWebSocketParams,
  }).strict(),
  z.object({
    type: z.literal('request'),
    id: zRequestId,
    method: z.literal('metrics.collect'),
    params: z.object({}).strict(),
  }).strict(),
]);

export const zAgentCancel = z.object({
  type: z.literal('cancel'),
  id: zRequestId,
}).strict();

/** Backend -> agent control frames. */
export const zAgentBackendFrame = z.union([zAgentWelcome, zAgentRequest, zAgentCancel]);

export const AGENT_ERROR_CODES = [
  'policy_denied',
  'bad_request',
  'incus_unavailable',
  'timeout',
  'cancelled',
  'too_large',
  'internal',
] as const;
export type AgentErrorCode = typeof AGENT_ERROR_CODES[number];

export const zAgentResponse = z.discriminatedUnion('ok', [
  z.object({
    type: z.literal('response'),
    id: zRequestId,
    ok: z.literal(true),
    result: z.unknown(),
  }).strict(),
  z.object({
    type: z.literal('response'),
    id: zRequestId,
    ok: z.literal(false),
    error: z.object({
      code: z.enum(AGENT_ERROR_CODES),
      message: z.string().max(1024),
    }).strict(),
  }).strict(),
]);

/** Agent -> Backend control frames. */
export const zAgentFrame = z.union([zAgentHello, zAgentResponse]);

export type AgentEnrollRequest = z.infer<typeof zAgentEnrollRequest>;
export type AgentEnrollResponse = z.infer<typeof zAgentEnrollResponse>;
export type AgentHello = z.infer<typeof zAgentHello>;
export type AgentWelcome = z.infer<typeof zAgentWelcome>;
export type AgentRequest = z.infer<typeof zAgentRequest>;
export type AgentCancel = z.infer<typeof zAgentCancel>;
export type AgentBackendFrame = z.infer<typeof zAgentBackendFrame>;
export type AgentResponse = z.infer<typeof zAgentResponse>;
export type AgentFrame = z.infer<typeof zAgentFrame>;
export type AgentIncusHttpParams = z.infer<typeof zAgentIncusHttpParams>;
export type AgentIncusHttpResult = z.infer<typeof zAgentIncusHttpResult>;
export type AgentIncusWebSocketParams = z.infer<typeof zAgentIncusWebSocketParams>;
export type AgentMetricsResult = z.infer<typeof zAgentMetricsResult>;
