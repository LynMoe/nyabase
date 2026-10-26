export const INCUS_USER_KEYS = {
  managed: 'user.nyabase.managed',
  containerId: 'user.nyabase.container_id',
  serverId: 'user.nyabase.server_id',
  revision: 'user.nyabase.revision',
  preflight: 'user.nyabase.preflight',
} as const;

export const DEFAULT_IMAGE_SOURCE_SERVER =
  'https://nyabase-images.nyabase-lxc-images.workers.dev';

export const MAX_MANAGED_CONTAINERS_PER_SERVER = 64;
export const MAX_SERVER_CONCURRENCY = 8;
export const MAX_PLATFORM_ACTIVE_USERS = 128;
export const MAX_PLATFORM_SERVERS = 16;
export const MAX_PLATFORM_IMAGES = 256;
export const MAX_SSH_PUBLIC_KEYS_PER_USER = 4;
export const MAX_SSH_PUBLIC_KEY_TEXT_LENGTH = 1_024;

export const MAX_SSH_PROXY_CONTAINERS =
  MAX_PLATFORM_SERVERS * MAX_MANAGED_CONTAINERS_PER_SERVER;
/** Same as the SSH proxy's hard NYABASE_SSH_MAX_CONNECTIONS ceiling (tools/ssh-proxy config.rs). */
export const MAX_SSH_PROXY_STATUS_CONNECTIONS = 1_024;
/** Same as the HTTP proxy's hard NYABASE_HTTP_MAX_CONNECTIONS ceiling (tools/http-proxy config.rs). */
export const MAX_HTTP_PROXY_ACTIVE_CONNECTIONS = 65_536;
export const MAX_SSH_PROXY_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_HTTP_PROXY_ROUTES = MAX_SSH_PROXY_CONTAINERS;
export const MAX_HTTP_PROXY_DOMAIN_POOLS = 16;
export const MAX_HTTP_PROXY_CERTIFICATE_PEM_LENGTH = 64 * 1024;
export const MAX_HTTP_PROXY_PRIVATE_KEY_PEM_LENGTH = 16 * 1024;
export const MAX_HTTP_PROXY_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/** Highest logical CPU id the platform accepts (reserved CPUs, topology, pinning). */
export const MAX_SERVER_LOGICAL_CPU_ID = 4095;
export const MAX_RESOURCE_BYTES = Number.MAX_SAFE_INTEGER;
export const MAX_STORAGE_OVERCOMMIT_RATIO = 100;
export const GRANT_EXPIRY_GRACE_DAYS = 14;

export const MAX_METRIC_POINTS_PER_BATCH = 4_096;
export const MAX_METRIC_NAME_LENGTH = 128;
export const MAX_METRIC_LABELS_PER_POINT = 16;
export const MAX_METRIC_LABEL_KEY_LENGTH = 64;
export const MAX_METRIC_LABEL_VALUE_LENGTH = 512;
export const MAX_NODE_METRICS_BODY_BYTES = 4 * 1024 * 1024;
/** Bound on one agent metrics.collect round trip. */
export const NODE_METRICS_REQUEST_TIMEOUT_MS = 5_000;
export const NODE_METRICS_PARSE_TIMEOUT_MS = 250;
export const NODE_METRICS_SCRAPE_INTERVAL_MS = 15_000;
export const NODE_METRICS_FRESHNESS_MS = 45_000;
export const NODE_METRICS_FAILURE_THRESHOLD = 3;
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
  'nyabase_node_ipv6_guard_present',
  'nyabase_node_firewall_present',
  'nyabase_container_cpu_usage_seconds_total',
  'nyabase_container_cpu_limit_cores',
  'nyabase_container_mem_used_bytes',
  'nyabase_container_mem_limit_bytes',
  'nyabase_container_disk_io_read_bytes_total',
  'nyabase_container_disk_io_write_bytes_total',
  'nyabase_container_cgroup_observed',
  'nyabase_container_cgroup_truncated',
  'nyabase_container_root_used_bytes',
  'nyabase_container_root_size_bytes',
  'nyabase_container_net_rx_bytes_total',
  'nyabase_container_net_tx_bytes_total',
  'nyabase_container_volume_used_bytes',
  'nyabase_container_volume_size_bytes',
  'nyabase_container_gpu_mem_limit_bytes',
  'nyabase_node_mem_used_bytes',
  'nyabase_node_mem_total_bytes',
  'nyabase_storage_pool_used_bytes',
  'nyabase_storage_pool_size_bytes',
] as const;

export const INCUS_REQUEST_TIMEOUT_MS = 10_000;
export const INCUS_OPERATION_WAIT_TIMEOUT_MS = 120_000;
export const MAX_INTENT_LIST_PAGE_SIZE = 100;
export const ADMIN_INTENT_LIST_MAX = 500;
export const MAX_CONSOLE_COMMAND_ARGUMENTS = 32;
export const MAX_CONSOLE_COMMAND_ARGUMENT_BYTES = 4_096;
export const CONSOLE_DEFAULT_COLS = 100;
export const CONSOLE_DEFAULT_ROWS = 30;
export const SSH_PROXY_SNAPSHOT_STALE_MIN_MS = 120_000;
export const SSH_PROXY_SNAPSHOT_STALE_MAX_MS = 300_000;
export const PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS = 30_000;
export const PROXY_SNAPSHOT_DRAIN_MARGIN_MS = 30_000;
export const CONTAINER_DELETE_PROXY_DRAIN_MS =
  SSH_PROXY_SNAPSHOT_STALE_MAX_MS
  + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS
  + PROXY_SNAPSHOT_DRAIN_MARGIN_MS;
