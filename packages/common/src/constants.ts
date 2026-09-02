export const INCUS_USER_KEYS = {
  managed: 'user.nyabase.managed',
  containerId: 'user.nyabase.container_id',
  serverId: 'user.nyabase.server_id',
  generation: 'user.nyabase.generation',
  preflight: 'user.nyabase.preflight',
} as const;

export const INCUS_INSTANCE_NAME_PREFIX = 'nyc-';
export const INCUS_VOLUME_NAME_PREFIX = 'nyv-';
export const INCUS_DEVICE_NAME_PREFIX = 'nyd-';
export const INCUS_DEFAULT_PROJECT = 'default';
export const INCUS_API_DEFAULT_PORT = 8_443;

export const MAX_MANAGED_CONTAINERS_PER_SERVER = 64;
export const MAX_SERVER_CONCURRENCY = 8;
export const MAX_PLATFORM_ACTIVE_USERS = 128;
export const MAX_PLATFORM_SERVERS = 16;
export const MAX_PLATFORM_IMAGES = 256;
export const MAX_PLATFORM_GROUPS = 256;
export const MAX_GROUP_MEMBERS = 64;
export const MAX_STORAGE_POOLS_PER_SERVER = 64;
export const MAX_SHARED_BACKENDS = 256;
export const MAX_VOLUMES_PER_USER = 1_024;
export const MAX_VOLUME_ATTACHMENTS = 64;
export const MAX_SSH_PUBLIC_KEYS_PER_USER = 4;
export const MAX_SSH_PUBLIC_KEY_TEXT_LENGTH = 1_024;

export const MAX_SSH_PROXY_CONTAINERS =
  MAX_PLATFORM_SERVERS * MAX_MANAGED_CONTAINERS_PER_SERVER;
export const MAX_SSH_PROXY_STATUS_CONNECTIONS = 1_024;
export const MAX_HTTP_PROXY_ACTIVE_CONNECTIONS = 32;
export const MAX_SSH_PROXY_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_HTTP_PROXY_ROUTES = MAX_SSH_PROXY_CONTAINERS;
export const MAX_HTTP_PROXY_DOMAIN_POOLS = 16;
export const MAX_HTTP_PROXY_CERTIFICATE_PEM_LENGTH = 64 * 1024;
export const MAX_HTTP_PROXY_PRIVATE_KEY_PEM_LENGTH = 16 * 1024;
export const MAX_HTTP_PROXY_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export const MAX_RESOURCE_CPU_MILLIS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000);
export const MAX_RESOURCE_BYTES = Number.MAX_SAFE_INTEGER;
export const MAX_GROUP_PRIORITY = Number.MAX_SAFE_INTEGER;
export const MAX_STORAGE_OVERCOMMIT_RATIO = 100;
export const GRANT_EXPIRY_GRACE_DAYS = 14;

export const MAX_METRIC_POINTS_PER_BATCH = 4_096;
export const MAX_METRIC_NAME_LENGTH = 128;
export const MAX_METRIC_LABELS_PER_POINT = 16;
export const MAX_METRIC_LABEL_KEY_LENGTH = 64;
export const MAX_METRIC_LABEL_VALUE_LENGTH = 512;
export const MAX_NODE_METRICS_BODY_BYTES = 4 * 1024 * 1024;
export const NODE_METRICS_ENDPOINT_PATH = '/metrics';
export const NODE_METRICS_CONNECT_TIMEOUT_MS = 500;
export const NODE_METRICS_RESPONSE_HEADER_TIMEOUT_MS = 1_000;
export const NODE_METRICS_REQUEST_TIMEOUT_MS = 2_000;
export const NODE_METRICS_PARSE_TIMEOUT_MS = 250;
export const NODE_METRICS_SCRAPE_INTERVAL_MS = 15_000;
export const NODE_METRICS_FRESHNESS_MS = 45_000;
export const NODE_METRICS_FAILURE_THRESHOLD = 3;
export const ECMASCRIPT_DATE_MAX_EPOCH_MS = 8_640_000_000_000_000;
export const NODE_METRIC_NAMES = [
  'nyabase_node_cpu_usage_ratio',
  'nyabase_node_cpu_psi_ratio',
  'nyabase_node_disk_io_read_bytes_total',
  'nyabase_node_disk_io_write_bytes_total',
  'nyabase_node_disk_io_read_seconds_total',
  'nyabase_node_disk_io_write_seconds_total',
  'nyabase_node_disk_smart_health',
  'nyabase_node_network_forwarding',
  'nyabase_node_network_rp_filter',
  'nyabase_node_network_fib_rule_present',
  'nyabase_node_network_is_bridge',
  'nyabase_node_network_ipv4_present',
  'nyabase_node_network_bridge_slave',
  'nyabase_node_network_nft_available',
  'nyabase_node_network_bridge_filter_present',
  'nyabase_node_network_bridge_filter_address',
] as const;

export const INCUS_CONNECT_TIMEOUT_MS = 500;
export const INCUS_RESPONSE_HEADER_TIMEOUT_MS = 1_000;
export const INCUS_REQUEST_TIMEOUT_MS = 10_000;
export const INCUS_OPERATION_WAIT_TIMEOUT_MS = 120_000;
export const INCUS_EVENT_RECONNECT_DELAY_MS = 1_000;
export const INCUS_BUSY_ATTENTION_RETRY_COUNT = 5;
export const INCUS_BUSY_ATTENTION_WINDOW_MS = 5 * 60_000;

export const INTENT_CLAIM_LEASE_MS = 60_000;
export const INTENT_CLAIM_RENEW_INTERVAL_MS = 20_000;
export const INTENT_MAX_FAILURE_DETAILS_BYTES = 16 * 1024;
export const INTENT_MAX_REQUEST_SUMMARY_BYTES = 16 * 1024;
export const MAX_INTENT_LIST_PAGE_SIZE = 100;
export const MAX_CONSOLE_COMMAND_ARGUMENTS = 32;
export const MAX_CONSOLE_COMMAND_ARGUMENT_BYTES = 4_096;
export const CONSOLE_DEFAULT_COLS = 100;
export const CONSOLE_DEFAULT_ROWS = 30;
export const CONSOLE_UNCLAIMED_TTL_MS = 60_000;
export const CONSOLE_CLAIMED_IDLE_TTL_MS = 30 * 60_000;

export const SSH_PROXY_SNAPSHOT_STALE_MIN_MS = 120_000;
export const SSH_PROXY_SNAPSHOT_STALE_MAX_MS = 300_000;
export const PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS = 30_000;
export const PROXY_SNAPSHOT_DRAIN_MARGIN_MS = 30_000;
export const CONTAINER_DELETE_PROXY_DRAIN_MS =
  SSH_PROXY_SNAPSHOT_STALE_MAX_MS
  + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS
  + PROXY_SNAPSHOT_DRAIN_MARGIN_MS;
