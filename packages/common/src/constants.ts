/** Docker labels that remain authoritative identity/discovery hints. */
export const LABEL = {
  MANAGED: 'nyabase.managed',
  CONTAINER_ID: 'nyabase.container_id',
  SERVER_ID: 'nyabase.server_id',
  SPEC_GENERATION: 'nyabase.spec_generation',
  RUNTIME_SPEC_HASH: 'nyabase.runtime_spec_hash',
} as const;

export const NYABASE_NETWORK = 'nyabase_net';

/** One bounded inventory shape shared by admission, Agent mutation and wire validation. */
// One full report inspects every runtime several times inside a 90s fail-stop
// deadline. Keep one bounded 64-way batch so the public maximum is actually
// observable under the slowest supported Docker read deadlines.
export const MAX_MANAGED_CONTAINERS_PER_AGENT = 64;
export const MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER =
  MAX_MANAGED_CONTAINERS_PER_AGENT * 2;
export const MAX_AGENT_MACVLAN_RESERVED_IPS = 4_096;
/** Small fixed product caps keep complete proxy snapshots comfortably bounded. */
export const MAX_PLATFORM_ACTIVE_USERS = 128;
export const MAX_PLATFORM_SERVERS = 16;
export const MAX_PLATFORM_IMAGES = 256;
export const MAX_SSH_PUBLIC_KEYS_PER_USER = 4;
export const MAX_SSH_PUBLIC_KEY_TEXT_LENGTH = 1_024;
export const MAX_SSH_PROXY_CONTAINERS =
  MAX_PLATFORM_SERVERS * MAX_MANAGED_CONTAINERS_PER_AGENT;
export const MAX_SSH_PROXY_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_HTTP_PROXY_ROUTES = MAX_SSH_PROXY_CONTAINERS;
export const MAX_HTTP_PROXY_DOMAIN_POOLS = 16;
export const MAX_HTTP_PROXY_CERTIFICATE_PEM_LENGTH = 64 * 1024;
export const MAX_HTTP_PROXY_PRIVATE_KEY_PEM_LENGTH = 16 * 1024;
export const MAX_HTTP_PROXY_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_CONTAINER_MOUNTS = 64;
export const MAX_MANAGED_DATA_DIRS_PER_AGENT = 4_096;
export const MAX_AGENT_LOCAL_DATA_SOURCES = 128;
/** Keeps the worst-case RemoteFS bootstrap well below the shared WS frame cap. */
export const MAX_AGENT_REMOTE_FS_MOUNTS = 128;
export const MAX_AGENT_XFS_PROJECTS = 4_096;
/** XFS project identity is a deterministic, protocol-visible user mapping. */
export const XFS_PROJECT_ID_OFFSET = 10_000;
export const XFS_PROJECT_ID_MAX = 0xffff_ffff;
export const MAX_AGENT_LOCAL_IMAGES = 8_192;
export const MAX_AGENT_DISKS = 128;
export const MAX_AGENT_GPU_DEVICES = 256;
/** Lossy telemetry is intentionally much smaller than authoritative inventory. */
export const MAX_METRIC_POINTS_PER_BATCH = 4_096;
export const MAX_METRIC_NAME_LENGTH = 128;
export const MAX_METRIC_LABELS_PER_POINT = 16;
export const MAX_METRIC_LABEL_KEY_LENGTH = 64;
export const MAX_METRIC_LABEL_VALUE_LENGTH = 512;
/** Exact WebSocket frame ceiling shared by Agent encoding and Backend parsing. */
export const MAX_AGENT_WS_FRAME_BYTES = 8 * 1024 * 1024;
/** Durable task outcomes are control evidence, never bulk log transport. */
export const MAX_AGENT_TASK_RESULT_BYTES = 64 * 1024;
/**
 * Covers the bounded pre-bootstrap Docker quiesce, systemd convergence and
 * macvlan reconciliation budget with margin. Heartbeats remain active after
 * hello while this RPC is pending.
 */
export const AGENT_BOOTSTRAP_RPC_TIMEOUT_MS = 15 * 60_000;
/**
 * Initial inventory collection itself is bounded to 90s on the Agent. Leave a
 * further bounded window for validating and atomically applying the largest
 * supported inventory before the Backend retires the connection.
 */
export const AGENT_INITIAL_STATE_REPORT_TIMEOUT_MS = 5 * 60_000;
/** Longest normal physical task is a 30 minute image pull, then a 90s report. */
export const AGENT_STEADY_STATE_REPORT_TIMEOUT_MS = 35 * 60_000;

/**
 * SSH proxy snapshots are an independent, short fail-closed route lease. They
 * intentionally expire well before the longer Agent report watchdog used to
 * accommodate a serialized 30-minute image pull.
 */
export const SSH_PROXY_SNAPSHOT_STALE_MIN_MS = 120_000;
export const SSH_PROXY_SNAPSHOT_STALE_MAX_MS = 300_000;

/**
 * Backend and standalone proxy wall clocks must stay within this bound.
 * Snapshots carry an absolute validUntil, so a delayed old control frame can
 * never acquire a fresh receive-time lease. A proxy whose clock is ahead
 * fails closed early; a clock behind by at most this amount is covered by the
 * container-delete drain barrier.
 */
export const PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS = 30_000;

/** Time for lease-expiry cancellation and socket teardown to settle. */
export const PROXY_SNAPSHOT_DRAIN_MARGIN_MS = 30_000;

/** Physical address reuse waits past every old proxy lease and clock skew. */
export const CONTAINER_DELETE_PROXY_DRAIN_MS =
  SSH_PROXY_SNAPSHOT_STALE_MAX_MS
  + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS
  + PROXY_SNAPSHOT_DRAIN_MARGIN_MS;
