--
-- Nyabase PostgreSQL initial schema.
-- Fresh installations only; this migration is the complete clean-cutover schema.
--

SET LOCAL check_function_bodies = false;

CREATE SCHEMA audit;
CREATE SCHEMA control;
CREATE SCHEMA iam;
CREATE SCHEMA infra;
CREATE SCHEMA interaction;
CREATE SCHEMA IF NOT EXISTS system;

COMMENT ON SCHEMA audit IS 'Append-only audit events with bounded retention';
COMMENT ON SCHEMA control IS 'Desired state and authoritative control-plane projections';
COMMENT ON SCHEMA iam IS 'Identity, authentication, authorization, and grants';
COMMENT ON SCHEMA infra IS 'Managed servers, images, storage pools, and shared backends';

CREATE TABLE audit.events (
    id uuid NOT NULL,
    actor_id text,
    actor_name text,
    actor_username text,
    actor_snapshot jsonb,
    action text NOT NULL,
    target_id text,
    target_type text,
    target_name text,
    target_snapshot jsonb,
    related jsonb DEFAULT '[]'::jsonb NOT NULL,
    detail jsonb,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT audit_actor_snapshot_object
        CHECK (actor_snapshot IS NULL OR jsonb_typeof(actor_snapshot) = 'object'),
    CONSTRAINT audit_target_snapshot_object
        CHECK (target_snapshot IS NULL OR jsonb_typeof(target_snapshot) = 'object'),
    CONSTRAINT events_action_check
        CHECK (length(action) BETWEEN 1 AND 128 AND action = lower(action)),
    CONSTRAINT events_related_check
        CHECK (jsonb_typeof(related) = 'array')
);

COMMENT ON TABLE audit.events IS
  'Append-only control-plane audit facts; DELETE is reserved for configured retention';
COMMENT ON COLUMN audit.events.actor_snapshot IS
  'Immutable actor identity snapshot captured in the same transaction as the event';
COMMENT ON COLUMN audit.events.detail IS
  'Sanitized event detail; credential-like fields are redacted before insertion';

CREATE TABLE iam.policy_state (
    singleton boolean DEFAULT true NOT NULL,
    policy_epoch bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT policy_state_singleton_check CHECK (singleton),
    CONSTRAINT policy_state_policy_epoch_check CHECK (policy_epoch >= 0),
    PRIMARY KEY (singleton)
);

COMMENT ON TABLE iam.policy_state IS
  'Singleton serialization point for monotonic authorization policy epochs';

CREATE TABLE iam.users (
    id uuid NOT NULL,
    numeric_id integer NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    display_name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    auth_version integer DEFAULT 0 NOT NULL,
    authz_version bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT users_numeric_id_check CHECK (numeric_id BETWEEN 1 AND 4096),
    CONSTRAINT users_username_check
        CHECK (username = lower(username) AND username ~ '^[a-z0-9_-]{2,64}$'),
    CONSTRAINT users_display_name_check
        CHECK (length(btrim(display_name)) BETWEEN 1 AND 128),
    CONSTRAINT users_status_check
        CHECK (status = ANY (ARRAY['active', 'disabled', 'deleting', 'deleted'])),
    CONSTRAINT users_auth_version_check CHECK (auth_version >= 0),
    CONSTRAINT users_authz_version_check CHECK (authz_version >= 0),
    PRIMARY KEY (id)
);

COMMENT ON COLUMN iam.users.auth_version IS
  'Browser-session generation embedded in access JWTs';
COMMENT ON COLUMN iam.users.authz_version IS
  'Monotonic authorization snapshot version incremented with policy changes';

CREATE TABLE iam.groups (
    id uuid NOT NULL,
    name text NOT NULL,
    description text,
    priority integer DEFAULT 0 NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    system_key text,
    capabilities text[] DEFAULT ARRAY[]::text[] NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT groups_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 128),
    CONSTRAINT groups_revision_check CHECK (revision >= 1),
    CONSTRAINT groups_system_identity_check
        CHECK ((is_system AND system_key IS NOT NULL) OR (NOT is_system AND system_key IS NULL)),
    PRIMARY KEY (id)
);

CREATE TABLE iam.group_members (
    id uuid NOT NULL,
    group_id uuid NOT NULL REFERENCES iam.groups(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE iam.refresh_tokens (
    id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
    hash character(64) NOT NULL,
    previous_hash character(64),
    previous_request_id_hash character(64),
    expires_at timestamp with time zone NOT NULL,
    revoked boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT refresh_tokens_hash_check CHECK (hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT refresh_tokens_predecessor_shape_check
        CHECK ((previous_hash IS NULL AND previous_request_id_hash IS NULL)
            OR (previous_hash IS NOT NULL AND previous_request_id_hash IS NOT NULL))
);

COMMENT ON COLUMN iam.refresh_tokens.previous_hash IS
  'One-step predecessor used only for exact response recovery and logout-after-rotation';

CREATE TABLE iam.api_tokens (
    id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
    name text NOT NULL,
    hash character(64) NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT api_tokens_hash_check CHECK (hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT api_tokens_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 128)
);

CREATE TABLE iam.ssh_public_keys (
    id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
    name text NOT NULL,
    key_text text NOT NULL,
    fingerprint text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ssh_public_keys_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 128)
);

CREATE TABLE infra.shared_backends (
    id uuid NOT NULL,
    name text NOT NULL,
    display_name text,
    identity_key text NOT NULL,
    ceph_fsid text NOT NULL,
    total_bytes bigint,
    used_bytes bigint,
    overcommit_ratio numeric(6,3) DEFAULT 1.000 NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT shared_backends_name_check CHECK (length(btrim(name)) > 0),
    CONSTRAINT shared_backends_identity_key_check CHECK (length(btrim(identity_key)) > 0),
    CONSTRAINT shared_backends_ceph_fsid_check
        CHECK (ceph_fsid ~ '^[0-9a-fA-F-]{36}$'),
    CONSTRAINT shared_backends_total_bytes_check CHECK (total_bytes IS NULL OR total_bytes >= 0),
    CONSTRAINT shared_backends_used_bytes_check CHECK (used_bytes IS NULL OR used_bytes >= 0),
    CONSTRAINT shared_backends_overcommit_check
        CHECK (overcommit_ratio >= 1.000 AND overcommit_ratio <= 100.000),
    CONSTRAINT shared_backends_revision_check CHECK (revision > 0),
    PRIMARY KEY (id)
);

CREATE TABLE infra.servers (
    id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    api_endpoint text NOT NULL,
    server_cert_fingerprint text,
    incus_version text,
    api_extensions text[] DEFAULT ARRAY[]::text[] NOT NULL,
    system_pool_id uuid,
    storage_overcommit_ratio numeric(6,3) DEFAULT 1.000 NOT NULL,
    -- Unmanaged Linux bridge ifname used as Incus NIC parent (e.g. vmbr0).
    -- Not a physical/bond NIC. nyabase never creates this device.
    parent_interface text,
    dns_servers text[] DEFAULT ARRAY[]::text[] NOT NULL,
    status text DEFAULT 'unknown'::text NOT NULL,
    last_seen_at timestamp with time zone,
    last_error text,
    revision bigint DEFAULT 1 NOT NULL,
    node_metrics_endpoint text,
    node_metrics_server_cert_fingerprint text,
    node_metrics_token_ciphertext text,
    node_metrics_token_fingerprint text,
    node_metrics_status text DEFAULT 'unconfigured'::text NOT NULL,
    node_metrics_last_success_at timestamp with time zone,
    node_metrics_outage_since timestamp with time zone,
    node_metrics_last_error text,
    preflight_status text DEFAULT 'not_run'::text NOT NULL,
    preflight_checked_at timestamp with time zone,
    preflight_report jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT servers_name_check CHECK (length(btrim(name)) > 0),
    CONSTRAINT servers_slug_check
        CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9][a-z0-9_-]*$'),
    CONSTRAINT servers_api_endpoint_check
        CHECK (api_endpoint ~ '^https://[^[:space:]]+$'),
    CONSTRAINT servers_cert_fingerprint_check
        CHECK (server_cert_fingerprint IS NULL OR server_cert_fingerprint ~ '^[0-9A-Fa-f:]{32,95}$'),
    CONSTRAINT servers_node_metrics_endpoint_check
        CHECK (node_metrics_endpoint IS NULL OR node_metrics_endpoint ~ '^https://[^[:space:]]+/metrics$'),
    CONSTRAINT servers_node_metrics_token_shape_check
        CHECK ((node_metrics_status = 'unconfigured'
                AND node_metrics_token_ciphertext IS NULL
                AND node_metrics_token_fingerprint IS NULL)
            OR (node_metrics_status <> 'unconfigured'
                AND node_metrics_endpoint IS NOT NULL
                AND node_metrics_token_ciphertext IS NOT NULL
                AND node_metrics_token_fingerprint IS NOT NULL)),
    CONSTRAINT servers_node_metrics_status_check
        CHECK (node_metrics_status = ANY (ARRAY['unconfigured', 'online', 'unreachable', 'unknown'])),
    CONSTRAINT servers_dns_servers_check
        CHECK (array_position(dns_servers, NULL::text) IS NULL),
    CONSTRAINT servers_status_check
        CHECK (status = ANY (ARRAY['online', 'unreachable', 'unknown'])),
    CONSTRAINT servers_overcommit_check
        CHECK (storage_overcommit_ratio >= 1.000 AND storage_overcommit_ratio <= 100.000),
    CONSTRAINT servers_preflight_status_check
        CHECK (preflight_status = ANY (ARRAY['not_run', 'running', 'passed', 'failed'])),
    CONSTRAINT servers_preflight_report_check
        CHECK (preflight_report IS NULL OR jsonb_typeof(preflight_report) = 'object'),
    CONSTRAINT servers_revision_check CHECK (revision > 0),
    PRIMARY KEY (id)
);

CREATE TABLE infra.server_extensions (
    server_id uuid NOT NULL REFERENCES infra.servers(id) ON DELETE CASCADE,
    extension_id text NOT NULL,
    enabled boolean NOT NULL DEFAULT false,
    health jsonb NOT NULL DEFAULT '{}'::jsonb,
    enabled_by uuid REFERENCES iam.users(id) ON DELETE SET NULL,
    enabled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (server_id, extension_id),
    CONSTRAINT server_extensions_id_check
        CHECK (extension_id ~ '^[a-z][a-z0-9-]{0,62}$'),
    CONSTRAINT server_extensions_health_object
        CHECK (jsonb_typeof(health) = 'object')
);

CREATE TABLE infra.ip_pools (
    id uuid NOT NULL,
    name text NOT NULL,
    cidr cidr NOT NULL,
    allocation_cidr cidr NOT NULL,
    gateway inet NOT NULL,
    reserved_ips jsonb DEFAULT '[]'::jsonb NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ip_pools_name_check CHECK (length(btrim(name)) > 0),
    CONSTRAINT ip_pools_reserved_ips_check
        CHECK (jsonb_typeof(reserved_ips) = 'array'),
    CONSTRAINT ip_pools_gateway_shape_check
        CHECK (gateway <<= cidr),
    CONSTRAINT ip_pools_allocation_cidr_shape_check
        CHECK (allocation_cidr <<= cidr),
    CONSTRAINT ip_pools_revision_check CHECK (revision > 0),
    PRIMARY KEY (id)
);

CREATE TABLE infra.ip_pool_servers (
    pool_id uuid NOT NULL REFERENCES infra.ip_pools(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES infra.servers(id) ON DELETE CASCADE,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    PRIMARY KEY (pool_id, server_id)
);

CREATE TABLE infra.storage_pools (
    id uuid NOT NULL,
    server_id uuid NOT NULL REFERENCES infra.servers(id) ON DELETE RESTRICT,
    incus_name text NOT NULL,
    driver text NOT NULL,
    resize_family text NOT NULL,
    root_disk_capable boolean NOT NULL,
    shareable boolean DEFAULT false NOT NULL,
    block_filesystem text,
    shared_backend_id uuid REFERENCES infra.shared_backends(id) ON DELETE RESTRICT,
    total_bytes bigint,
    used_bytes bigint,
    quota_effective boolean,
    display_name text,
    registered boolean DEFAULT false NOT NULL,
    last_observed_at timestamp with time zone,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT storage_pools_incus_name_check
        CHECK (length(btrim(incus_name)) > 0 AND incus_name !~ '[\000\r\n/]'),
    CONSTRAINT storage_pools_driver_check
        CHECK (driver = ANY (ARRAY['dir', 'btrfs', 'zfs', 'lvm', 'lvmcluster', 'ceph', 'cephfs'])),
    CONSTRAINT storage_pools_resize_family_check
        CHECK (resize_family = ANY (ARRAY['quota_online', 'block_backed'])),
    CONSTRAINT storage_pools_filesystem_check
        CHECK ((resize_family = 'block_backed' AND block_filesystem = 'ext4')
            OR (resize_family = 'quota_online' AND block_filesystem IS NULL)),
    CONSTRAINT storage_pools_shared_shape_check
        CHECK ((NOT registered AND shared_backend_id IS NULL)
            OR (NOT shareable AND shared_backend_id IS NULL)
            OR (shareable AND driver = 'cephfs' AND shared_backend_id IS NOT NULL)),
    CONSTRAINT storage_pools_root_capable_check
        CHECK ((NOT root_disk_capable) OR driver <> 'cephfs'),
    CONSTRAINT storage_pools_capacity_check
        CHECK ((total_bytes IS NULL OR total_bytes >= 0)
            AND (used_bytes IS NULL OR used_bytes >= 0)),
    CONSTRAINT storage_pools_revision_check CHECK (revision > 0),
    PRIMARY KEY (id)
);

ALTER TABLE infra.servers
    ADD CONSTRAINT servers_system_pool_fkey
    FOREIGN KEY (system_pool_id) REFERENCES infra.storage_pools(id) ON DELETE RESTRICT;

CREATE TABLE infra.images (
    id uuid NOT NULL,
    name text NOT NULL,
    alias text NOT NULL,
    fingerprint text,
    description text,
    login_user text DEFAULT 'root'::text NOT NULL,
    min_root_size_bytes bigint,
    network_managed_externally boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    deleting boolean DEFAULT false NOT NULL,
    cleanup_generation integer DEFAULT 0 NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT images_name_check CHECK (length(btrim(name)) > 0),
    CONSTRAINT images_alias_check CHECK (length(btrim(alias)) > 0),
    CONSTRAINT images_fingerprint_check
        CHECK (fingerprint IS NULL OR fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT images_login_user_check
        CHECK (login_user ~ '^[a-z_][a-z0-9_-]{0,31}$'),
    CONSTRAINT images_min_root_size_check
        CHECK (min_root_size_bytes IS NULL OR min_root_size_bytes > 0),
    CONSTRAINT images_cleanup_generation_check CHECK (cleanup_generation >= 0),
    CONSTRAINT images_deleting_shape_check CHECK (NOT deleting OR NOT is_active),
    CONSTRAINT images_revision_check CHECK (revision > 0),
    PRIMARY KEY (id)
);

CREATE TABLE infra.image_server_assignments (
    id uuid NOT NULL,
    image_id uuid NOT NULL REFERENCES infra.images(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES infra.servers(id) ON DELETE CASCADE,
    generation integer DEFAULT 1 NOT NULL,
    observed_fingerprint text,
    managed_fingerprint text,
    lifecycle_phase text DEFAULT 'provisioning'::text NOT NULL,
    needs_attention boolean DEFAULT false NOT NULL,
    failure_code text,
    failure_reason text,
    last_observed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT image_assignments_generation_check CHECK (generation > 0),
    CONSTRAINT image_assignment_observed_fingerprint_check
        CHECK (observed_fingerprint IS NULL OR observed_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT image_assignment_managed_fingerprint_check
        CHECK (managed_fingerprint IS NULL OR managed_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT image_assignment_phase_check
        CHECK (lifecycle_phase = ANY (ARRAY['provisioning', 'active', 'deleting', 'failed']))
);

CREATE TABLE iam.server_grants (
    id uuid NOT NULL,
    user_id uuid REFERENCES iam.users(id) ON DELETE CASCADE,
    group_id uuid REFERENCES iam.groups(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES infra.servers(id) ON DELETE RESTRICT,
    cpu_millis integer,
    mem_bytes bigint,
    disk_bytes bigint,
    extension_grants jsonb NOT NULL DEFAULT '{}'::jsonb,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT server_grants_scope_check
        CHECK ((user_id IS NOT NULL)::integer + (group_id IS NOT NULL)::integer = 1),
    CONSTRAINT server_grants_cpu_millis_check CHECK (cpu_millis IS NULL OR cpu_millis >= 0),
    CONSTRAINT server_grants_mem_bytes_check CHECK (mem_bytes IS NULL OR mem_bytes >= 0),
    CONSTRAINT server_grants_disk_bytes_check CHECK (disk_bytes IS NULL OR disk_bytes >= 0),
    CONSTRAINT server_grants_extension_grants_object
        CHECK (jsonb_typeof(extension_grants) = 'object')
);

CREATE TABLE iam.storage_pool_grants (
    id uuid NOT NULL,
    user_id uuid REFERENCES iam.users(id) ON DELETE CASCADE,
    group_id uuid REFERENCES iam.groups(id) ON DELETE CASCADE,
    pool_id uuid NOT NULL REFERENCES infra.storage_pools(id) ON DELETE RESTRICT,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT storage_pool_grants_scope_check
        CHECK ((user_id IS NOT NULL)::integer + (group_id IS NOT NULL)::integer = 1)
);

CREATE TABLE iam.shared_backend_grants (
    id uuid NOT NULL,
    user_id uuid REFERENCES iam.users(id) ON DELETE CASCADE,
    group_id uuid REFERENCES iam.groups(id) ON DELETE CASCADE,
    shared_backend_id uuid NOT NULL REFERENCES infra.shared_backends(id) ON DELETE RESTRICT,
    limit_bytes bigint DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT shared_backend_grants_scope_check
        CHECK ((user_id IS NOT NULL)::integer + (group_id IS NOT NULL)::integer = 1),
    CONSTRAINT shared_backend_grants_limit_check CHECK (limit_bytes >= 0)
);

CREATE TABLE control.containers (
    id uuid NOT NULL,
    server_id uuid NOT NULL REFERENCES infra.servers(id) ON DELETE RESTRICT,
    owner_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE RESTRICT,
    image_id uuid NOT NULL REFERENCES infra.images(id) ON DELETE RESTRICT,
    created_by uuid NOT NULL REFERENCES iam.users(id) ON DELETE RESTRICT,
    name text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    observed_generation integer,
    image_alias text NOT NULL,
    image_fingerprint text NOT NULL,
    root_pool_id uuid NOT NULL REFERENCES infra.storage_pools(id) ON DELETE RESTRICT,
    root_size_bytes bigint NOT NULL,
    root_size_pending_bytes bigint,
    cpu_millis integer DEFAULT 0 NOT NULL,
    mem_bytes bigint DEFAULT 0 NOT NULL,
    extensions jsonb NOT NULL DEFAULT '{}'::jsonb,
    nesting boolean DEFAULT true NOT NULL,
    syscall_intercept boolean DEFAULT true NOT NULL,
    power_intent text DEFAULT 'running'::text NOT NULL,
    lifecycle_phase text DEFAULT 'provisioning'::text NOT NULL,
    instance_name text,
    needs_attention boolean DEFAULT false NOT NULL,
    failure_code text,
    failure_reason text,
    last_transition_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT containers_name_check
        CHECK (length(name) BETWEEN 1 AND 63 AND name ~ '^[A-Za-z0-9][A-Za-z0-9-]*$'),
    CONSTRAINT containers_revision_check CHECK (revision > 0),
    CONSTRAINT containers_generation_check CHECK (generation > 0),
    CONSTRAINT containers_observed_generation_check
        CHECK (observed_generation IS NULL OR observed_generation > 0),
    CONSTRAINT containers_image_fingerprint_check CHECK (image_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT containers_root_size_check CHECK (root_size_bytes > 0),
    CONSTRAINT containers_root_size_pending_check
        CHECK (root_size_pending_bytes IS NULL OR root_size_pending_bytes > 0),
    CONSTRAINT containers_cpu_millis_check CHECK (cpu_millis >= 0),
    CONSTRAINT containers_mem_bytes_check CHECK (mem_bytes >= 0),
    CONSTRAINT containers_extensions_object
        CHECK (jsonb_typeof(extensions) = 'object'),
    CONSTRAINT containers_power_intent_check
        CHECK (power_intent = ANY (ARRAY['running', 'stopped'])),
    CONSTRAINT containers_lifecycle_phase_check
        CHECK (lifecycle_phase = ANY (ARRAY['provisioning', 'active', 'deleting', 'failed'])),
    CONSTRAINT containers_instance_name_check
        CHECK (instance_name IS NULL OR instance_name ~ '^nyc-[0-9a-f]{32}$'),
    CONSTRAINT containers_failure_shape_check
        CHECK (lifecycle_phase <> 'failed' OR failure_code IS NOT NULL),
    PRIMARY KEY (id)
);

COMMENT ON TABLE control.containers IS
  'Canonical container desired state, Incus identity, lifecycle, and capacity reservation';

CREATE TABLE control.volumes (
    id uuid NOT NULL,
    owner_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE RESTRICT,
    pool_id uuid REFERENCES infra.storage_pools(id) ON DELETE SET NULL,
    server_id uuid REFERENCES infra.servers(id) ON DELETE RESTRICT,
    shared_backend_id uuid REFERENCES infra.shared_backends(id) ON DELETE RESTRICT,
    name text NOT NULL,
    incus_name text NOT NULL,
    size_bytes bigint NOT NULL,
    used_bytes bigint,
    generation integer DEFAULT 1 NOT NULL,
    observed_generation integer,
    lifecycle_phase text DEFAULT 'provisioning'::text NOT NULL,
    needs_attention boolean DEFAULT false NOT NULL,
    failure_code text,
    dir_ensured boolean DEFAULT false NOT NULL,
    remove_all_committed boolean DEFAULT false NOT NULL,
    remove_all_server_id uuid REFERENCES infra.servers(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT volumes_name_check CHECK (length(btrim(name)) > 0),
    CONSTRAINT volumes_incus_name_check CHECK (incus_name ~ '^nyv-[0-9a-f]{32}$'),
    CONSTRAINT volumes_size_check CHECK (size_bytes > 0),
    CONSTRAINT volumes_used_bytes_check CHECK (used_bytes IS NULL OR used_bytes >= 0),
    CONSTRAINT volumes_generation_check CHECK (generation > 0),
    CONSTRAINT volumes_observed_generation_check
        CHECK (observed_generation IS NULL OR observed_generation > 0),
    CONSTRAINT volumes_lifecycle_check
        CHECK (lifecycle_phase = ANY (ARRAY['provisioning', 'active', 'deleting', 'failed'])),
    CONSTRAINT volumes_scope_check
        CHECK ((server_id IS NOT NULL AND shared_backend_id IS NULL AND pool_id IS NOT NULL)
            OR (server_id IS NULL AND shared_backend_id IS NOT NULL AND pool_id IS NULL)),
    CONSTRAINT volumes_remove_all_shape_check
        CHECK ((lifecycle_phase <> 'deleting'
            AND NOT remove_all_committed
            AND remove_all_server_id IS NULL)
            OR lifecycle_phase = 'deleting'),
    CONSTRAINT volumes_failure_shape_check
        CHECK (lifecycle_phase <> 'failed' OR failure_code IS NOT NULL),
    PRIMARY KEY (id)
);

CREATE TABLE control.volume_attachments (
    id uuid NOT NULL,
    container_id uuid NOT NULL REFERENCES control.containers(id) ON DELETE CASCADE,
    volume_id uuid NOT NULL REFERENCES control.volumes(id) ON DELETE RESTRICT,
    device_name text NOT NULL,
    container_path text NOT NULL,
    read_only boolean DEFAULT false NOT NULL,
    bind_state text DEFAULT 'attaching'::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT volume_attachments_path_check
        CHECK (container_path ~~ '/%' AND container_path <> '/' AND container_path !~ '[\000\r\n]'),
    CONSTRAINT volume_attachments_device_name_check
        CHECK (device_name ~ '^nyd-[0-9a-f]{32}$'),
    CONSTRAINT volume_attachments_bind_state_check
        CHECK (bind_state = ANY (ARRAY['attaching', 'attached', 'detaching']))
);

-- Per-Incus catalog registration for a logical volume. Nodes are equal; catalog
-- rows stick until volume destroy or control-plane server delete.
CREATE TABLE control.volume_placements (
    volume_id uuid NOT NULL REFERENCES control.volumes(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES infra.servers(id) ON DELETE RESTRICT,
    pool_id uuid NOT NULL REFERENCES infra.storage_pools(id) ON DELETE RESTRICT,
    catalog_state text NOT NULL,
    observed_generation integer,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    PRIMARY KEY (volume_id, server_id),
    CONSTRAINT volume_placements_state_check
        CHECK (catalog_state = ANY (ARRAY['ensuring', 'present'])),
    CONSTRAINT volume_placements_observed_generation_check
        CHECK (observed_generation IS NULL OR observed_generation > 0)
);

COMMENT ON TABLE control.volume_placements IS
  'Equal-node Incus catalog tracking; destroy phase lives on control.volumes';

CREATE TABLE control.container_network_claims (
    id uuid NOT NULL,
    container_id uuid REFERENCES control.containers(id) ON DELETE SET NULL,
    server_id uuid NOT NULL REFERENCES infra.servers(id) ON DELETE RESTRICT,
    network_key cidr NOT NULL,
    address inet NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    reusable_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    owner_kind text NOT NULL,
    owner_id uuid NOT NULL,
    cleanup_payload_json jsonb,
    CONSTRAINT container_network_claim_address_shape_check
        CHECK (family(network_key::inet) = family(address) AND address <<= network_key::inet),
    CONSTRAINT container_network_claim_owner_kind_check
        CHECK (owner_kind = ANY (ARRAY['container', 'runtime_cleanup'])),
    CONSTRAINT container_network_claim_owner_shape_check
        CHECK ((owner_kind = 'container'
                AND cleanup_payload_json IS NULL
                AND ((state = 'active' AND container_id IS NOT NULL AND owner_id = container_id)
                    OR state = 'releasing'))
            OR (owner_kind = 'runtime_cleanup'
                AND container_id IS NULL
                AND jsonb_typeof(cleanup_payload_json) = 'object')),
    CONSTRAINT container_network_claim_state_shape_check
        CHECK ((state = 'active' AND reusable_at IS NULL)
            OR (state = 'releasing' AND reusable_at IS NOT NULL)),
    CONSTRAINT container_network_claim_state_check
        CHECK (state = ANY (ARRAY['active', 'releasing']))
);

COMMENT ON COLUMN control.container_network_claims.owner_id IS
  'UUID owner retained during the routed address drain window';
COMMENT ON COLUMN control.container_network_claims.cleanup_payload_json IS
  'Bounded cleanup evidence for a releasing address reservation';

CREATE TABLE control.extension_device_claims (
    id uuid NOT NULL,
    extension_id text NOT NULL,
    server_id uuid NOT NULL REFERENCES infra.servers(id) ON DELETE RESTRICT,
    container_id uuid NOT NULL REFERENCES control.containers(id) ON DELETE CASCADE,
    device_key text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT extension_device_claims_id_check
        CHECK (extension_id ~ '^[a-z][a-z0-9-]{0,62}$'),
    CONSTRAINT extension_device_claims_key_check
        CHECK (length(device_key) BETWEEN 1 AND 256 AND device_key !~ '[[:space:]]'),
    CONSTRAINT extension_device_claims_container_device_key
        UNIQUE (container_id, extension_id, device_key),
    CONSTRAINT extension_device_claims_server_device_key
        UNIQUE (extension_id, server_id, device_key)
);

CREATE TABLE control.container_ssh_routes (
    container_id uuid NOT NULL REFERENCES control.containers(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES infra.servers(id) ON DELETE RESTRICT,
    instance_name text NOT NULL,
    routed_ip inet NOT NULL,
    instance_status text NOT NULL,
    instance_started_at timestamp with time zone,
    ssh_status text NOT NULL,
    last_error text,
    observed_at timestamp with time zone NOT NULL,
    CONSTRAINT container_ssh_routes_instance_name_check
        CHECK (instance_name ~ '^nyc-[0-9a-f]{32}$'),
    CONSTRAINT container_ssh_routes_ssh_status_check
        CHECK (ssh_status = ANY (ARRAY['disabled', 'container_stopped', 'running', 'error', 'unknown']))
);

CREATE TABLE control.authorization_dependencies (
    id uuid NOT NULL,
    dependency_kind text NOT NULL,
    dependency_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE RESTRICT,
    server_id uuid REFERENCES infra.servers(id) ON DELETE RESTRICT,
    pool_id uuid REFERENCES infra.storage_pools(id) ON DELETE RESTRICT,
    shared_backend_id uuid REFERENCES infra.shared_backends(id) ON DELETE RESTRICT,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT authorization_dependencies_kind_check
        CHECK (dependency_kind = ANY (ARRAY['container', 'volume', 'volume_attachment'])),
    CONSTRAINT authorization_dependencies_shape_check
        CHECK ((dependency_kind = 'container'
                AND server_id IS NOT NULL AND pool_id IS NULL AND shared_backend_id IS NULL)
            OR (dependency_kind IN ('volume', 'volume_attachment')
                AND ((server_id IS NOT NULL AND pool_id IS NOT NULL AND shared_backend_id IS NULL)
                    OR (server_id IS NULL AND pool_id IS NULL AND shared_backend_id IS NOT NULL)))
));

COMMENT ON TABLE control.authorization_dependencies IS
  'Transactional projection used to reject grant revocation while resources remain retained';

CREATE TABLE control.grant_expiry_enforcement (
    user_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES infra.servers(id) ON DELETE CASCADE,
    covering_expires_at timestamp with time zone NOT NULL,
    grace_stopped_at timestamp with time zone,
    purged_at timestamp with time zone,
    claim_token uuid,
    claimed_by text,
    lease_expires_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT grant_expiry_enforcement_claim_shape_check
        CHECK ((claim_token IS NULL AND claimed_by IS NULL AND lease_expires_at IS NULL)
            OR (claim_token IS NOT NULL AND claimed_by IS NOT NULL AND lease_expires_at IS NOT NULL))
);

COMMENT ON TABLE control.grant_expiry_enforcement IS
  'Idempotent grant-expiry worker ledger for grace stop and resource cleanup';

CREATE TABLE control.intents (
    id uuid NOT NULL,
    kind text NOT NULL,
    resource_type text NOT NULL,
    resource_id uuid NOT NULL,
    server_id uuid REFERENCES infra.servers(id) ON DELETE RESTRICT,
    requested_by uuid REFERENCES iam.users(id) ON DELETE SET NULL,
    request_json jsonb,
    target_generation integer NOT NULL,
    baseline_json jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    failure_code text,
    failure_json jsonb,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    blocked_by_intent_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT intents_kind_check
        CHECK (kind = ANY (ARRAY[
            'container.create',
            'container.update',
            'container.power',
            'container.delete',
            'volume.ensure',
            'volume.resize',
            'volume.destroy',
            'image_assignment.ensure',
            'image_assignment.delete',
            'server.connect',
            'server.preflight',
            'certificate.rotate'
        ])),
    CONSTRAINT intents_resource_type_check
        CHECK (resource_type = ANY (ARRAY[
            'container',
            'volume',
            'image_assignment',
            'server',
            'certificate_rotation'
        ])),
    CONSTRAINT intents_kind_resource_check
        CHECK ((kind LIKE 'container.%' AND resource_type = 'container')
            OR (kind LIKE 'volume.%' AND resource_type = 'volume')
            OR (kind LIKE 'image_assignment.%' AND resource_type = 'image_assignment')
            OR (kind LIKE 'server.%' AND resource_type = 'server')
            OR (kind = 'certificate.rotate' AND resource_type = 'certificate_rotation')),
    CONSTRAINT intents_resource_shape_check
        CHECK ((resource_type IN ('container', 'image_assignment', 'server')
                AND server_id IS NOT NULL)
            OR (resource_type = 'volume' AND kind IN ('volume.ensure', 'volume.resize')
                AND server_id IS NOT NULL)
            OR (resource_type = 'volume' AND kind = 'volume.destroy' AND server_id IS NULL)
            OR (resource_type = 'certificate_rotation' AND server_id IS NULL)),
    CONSTRAINT intents_blocked_by_check
        CHECK (blocked_by_intent_id IS NULL OR blocked_by_intent_id <> id),
    CONSTRAINT intents_target_generation_check CHECK (target_generation > 0),
    CONSTRAINT intents_status_check
        CHECK (status = ANY (ARRAY['pending', 'succeeded', 'failed'])),
    CONSTRAINT intents_settled_shape_check
        CHECK ((status = 'pending' AND settled_at IS NULL)
            OR (status <> 'pending' AND settled_at IS NOT NULL)),
    CONSTRAINT intents_failure_shape_check
        CHECK ((status <> 'failed' AND failure_code IS NULL)
            OR (status = 'failed' AND failure_code IS NOT NULL)),
    CONSTRAINT intents_request_json_check
        CHECK (request_json IS NULL OR jsonb_typeof(request_json) = 'object'),
    CONSTRAINT intents_baseline_json_check
        CHECK (baseline_json IS NULL OR jsonb_typeof(baseline_json) = 'object'),
    CONSTRAINT intents_failure_json_check
        CHECK (failure_json IS NULL
            OR (jsonb_typeof(failure_json) = 'object'
                AND failure_json ? 'code'
                AND failure_json ? 'message'
                AND failure_json ? 'details')),
    CONSTRAINT intents_attempt_count_check CHECK (attempt_count >= 0)
);

CREATE TABLE control.reconcile_claims (
    resource_type text NOT NULL,
    resource_id uuid NOT NULL,
    placement_server_id uuid NOT NULL,
    server_id uuid REFERENCES infra.servers(id) ON DELETE RESTRICT,
    worker_id text NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    claimed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT reconcile_claims_resource_type_check
        CHECK (resource_type = ANY (ARRAY[
            'container',
            'volume',
            'image_assignment',
            'server',
            'certificate_rotation'
        ])),
    CONSTRAINT reconcile_claims_worker_check CHECK (length(btrim(worker_id)) > 0),
    CONSTRAINT reconcile_claims_placement_shape_check
        CHECK (
            (placement_server_id = '00000000-0000-4000-8000-000000000000'
                AND server_id IS NULL
                AND resource_type = 'certificate_rotation')
            OR (placement_server_id = '00000000-0000-4000-8000-000000000001'
                AND server_id IS NULL
                AND resource_type = 'volume')
            OR (placement_server_id <> '00000000-0000-4000-8000-000000000000'
                AND placement_server_id <> '00000000-0000-4000-8000-000000000001'
                AND server_id = placement_server_id)
        ),
    PRIMARY KEY (resource_type, resource_id, placement_server_id)
);

COMMENT ON COLUMN control.reconcile_claims.placement_server_id IS
  'Incus catalog/server for the claim; certificate_rotation uses …0000, volume.destroy uses …0001';

CREATE TABLE system.settings (
    singleton boolean DEFAULT true NOT NULL,
    revision bigint NOT NULL,
    snapshot_token character(64) NOT NULL,
    "values" jsonb NOT NULL,
    updated_by uuid REFERENCES iam.users(id) ON DELETE SET NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT settings_singleton_check CHECK (singleton),
    CONSTRAINT settings_revision_check CHECK (revision BETWEEN 1 AND 9007199254740991),
    CONSTRAINT settings_snapshot_token_check CHECK (snapshot_token ~ '^[a-f0-9]{64}$'),
    CONSTRAINT settings_values_check CHECK (jsonb_typeof("values") = 'object')
);

COMMENT ON TABLE system.settings IS
  'PostgreSQL authority for the complete online-editable control-plane settings snapshot';
COMMENT ON COLUMN system.settings.revision IS
  'Absolute monotonic CAS version consumed by every API, gateway, and worker process';
COMMENT ON COLUMN system.settings.snapshot_token IS
  'Stable content identity paired with revision for stale-client conflict detection';
COMMENT ON COLUMN system.settings."values" IS
  'Complete validated online-editable values; deployment YAML is bootstrap/read-only only';

CREATE TABLE system.incus_client_certificates (
    id uuid NOT NULL,
    generation bigint NOT NULL,
    certificate_pem text NOT NULL,
    encrypted_private_key text NOT NULL,
    fingerprint text NOT NULL,
    not_before timestamp with time zone NOT NULL,
    not_after timestamp with time zone NOT NULL,
    state text NOT NULL,
    created_by uuid REFERENCES iam.users(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    activated_at timestamp with time zone,
    retired_at timestamp with time zone,
    CONSTRAINT incus_client_certificates_generation_check CHECK (generation > 0),
    CONSTRAINT incus_client_certificates_fingerprint_check
        CHECK (fingerprint ~ '^[0-9A-Fa-f:]{32,95}$'),
    CONSTRAINT incus_client_certificates_validity_check CHECK (not_after > not_before),
    CONSTRAINT incus_client_certificates_state_check
        CHECK (state = ANY (ARRAY['staged', 'active', 'retired', 'failed'])),
    CONSTRAINT incus_client_certificates_state_shape_check
        CHECK ((state = 'active' AND activated_at IS NOT NULL AND retired_at IS NULL)
            OR (state = 'retired' AND retired_at IS NOT NULL)
            OR (state IN ('staged', 'failed'))),
    PRIMARY KEY (id)
);

CREATE TABLE system.incus_client_certificate_trusts (
    certificate_id uuid NOT NULL
        REFERENCES system.incus_client_certificates(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES infra.servers(id) ON DELETE CASCADE,
    state text DEFAULT 'pending'::text NOT NULL,
    last_error text,
    observed_at timestamp with time zone,
    CONSTRAINT incus_client_certificate_trusts_state_check
        CHECK (state = ANY (ARRAY['pending', 'trusted', 'verified', 'revoked', 'cleanup_failed'])),
    PRIMARY KEY (certificate_id, server_id)
);

CREATE TABLE interaction.http_domain_pools (
    id uuid NOT NULL,
    wildcard_domain text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    https_enabled boolean DEFAULT false NOT NULL,
    certificate_pem text,
    encrypted_private_key_pem text,
    certificate_fingerprint text,
    certificate_not_after timestamp with time zone,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT http_domain_pools_wildcard_domain_check
        CHECK (wildcard_domain = lower(wildcard_domain) AND wildcard_domain ~~ '*.%'),
    CONSTRAINT http_domain_pools_revision_check CHECK (revision > 0),
    CONSTRAINT http_domain_pools_tls_shape_check
        CHECK ((certificate_pem IS NULL AND encrypted_private_key_pem IS NULL
                AND certificate_fingerprint IS NULL AND certificate_not_after IS NULL
                AND NOT https_enabled)
            OR (certificate_pem IS NOT NULL AND encrypted_private_key_pem IS NOT NULL
                AND certificate_fingerprint IS NOT NULL AND certificate_not_after IS NOT NULL)),
    PRIMARY KEY (id)
);

CREATE TABLE interaction.http_hostname_reservations (
    hostname text NOT NULL,
    owner_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE RESTRICT,
    binding_id uuid,
    state text NOT NULL,
    reusable_at timestamp with time zone,
    release_generation bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT http_hostname_reservations_hostname_check
        CHECK (hostname = lower(hostname) AND hostname !~ '[*]'),
    CONSTRAINT http_hostname_reservations_state_check
        CHECK (state = ANY (ARRAY['active', 'releasing'])),
    CONSTRAINT http_hostname_reservations_release_generation_check
        CHECK (release_generation >= 0),
    CONSTRAINT http_hostname_reservation_state_shape_check
        CHECK ((state = 'active' AND binding_id IS NOT NULL AND reusable_at IS NULL)
            OR (state = 'releasing' AND binding_id IS NULL
                AND reusable_at IS NOT NULL AND release_generation > 0))
);

COMMENT ON TABLE interaction.http_hostname_reservations IS
  'Durable active and draining hostname ownership; reusable_at is authoritative across crashes';
COMMENT ON COLUMN interaction.http_hostname_reservations.release_generation IS
  'Monotonic drain incarnation preventing stale release work from mutating a newer reservation';

CREATE TABLE interaction.http_proxy_bindings (
    id uuid NOT NULL,
    hostname text NOT NULL,
    domain_pool_id uuid NOT NULL REFERENCES interaction.http_domain_pools(id) ON DELETE RESTRICT,
    owner_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE RESTRICT,
    container_id uuid NOT NULL REFERENCES control.containers(id) ON DELETE CASCADE,
    target_port integer NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT http_proxy_bindings_hostname_check
        CHECK (hostname = lower(hostname) AND hostname !~ '[*]'),
    CONSTRAINT http_proxy_bindings_target_port_check CHECK (target_port BETWEEN 1 AND 65535),
    CONSTRAINT http_proxy_bindings_revision_check CHECK (revision > 0)
);

CREATE TABLE interaction.http_proxy_snapshot_state (
    singleton boolean DEFAULT true NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    lease_issued_at timestamp with time zone,
    lease_valid_until timestamp with time zone,
    payload_sha256 character(64),
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT http_proxy_snapshot_state_singleton_check CHECK (singleton),
    CONSTRAINT http_proxy_snapshot_state_generation_check CHECK (generation >= 0),
    CONSTRAINT http_proxy_snapshot_lease_shape_check
        CHECK ((generation = 0 AND lease_issued_at IS NULL AND lease_valid_until IS NULL
                AND payload_sha256 IS NULL)
            OR (generation > 0 AND lease_issued_at IS NOT NULL
                AND lease_valid_until IS NOT NULL AND lease_valid_until > lease_issued_at
                AND payload_sha256 ~ '^[0-9a-f]{64}$'))
);

CREATE TABLE interaction.ssh_proxy_host_keys (
    id text NOT NULL,
    encrypted_private_key text NOT NULL,
    public_key text NOT NULL,
    fingerprint text NOT NULL,
    generation integer NOT NULL,
    rotated_at timestamp with time zone NOT NULL,
    CONSTRAINT ssh_proxy_host_keys_id_check CHECK (id = 'singleton'),
    CONSTRAINT ssh_proxy_host_keys_generation_check CHECK (generation >= 1),
    PRIMARY KEY (id)
);

CREATE INDEX audit_events_action_idx
    ON audit.events (action, occurred_at DESC, id DESC);
CREATE INDEX audit_events_actor_idx
    ON audit.events (actor_id, occurred_at DESC, id DESC)
    WHERE actor_id IS NOT NULL;
CREATE INDEX audit_events_occurred_idx
    ON audit.events (occurred_at DESC, id DESC);
CREATE INDEX audit_events_target_idx
    ON audit.events (target_type, target_id, occurred_at DESC, id DESC)
    WHERE target_type IS NOT NULL OR target_id IS NOT NULL;
CREATE INDEX audit_events_target_id_idx
    ON audit.events (target_id, occurred_at DESC, id DESC)
    WHERE target_id IS NOT NULL;

ALTER TABLE iam.users ADD CONSTRAINT users_numeric_id_key UNIQUE (numeric_id);
ALTER TABLE iam.users ADD CONSTRAINT users_username_key UNIQUE (username);
ALTER TABLE iam.groups ADD CONSTRAINT groups_name_key UNIQUE (name);
ALTER TABLE iam.groups ADD CONSTRAINT groups_system_key_key UNIQUE (system_key);
ALTER TABLE iam.group_members ADD CONSTRAINT group_members_pkey PRIMARY KEY (id);
ALTER TABLE iam.group_members ADD CONSTRAINT group_members_group_id_user_id_key
    UNIQUE (group_id, user_id);
ALTER TABLE iam.refresh_tokens ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);
ALTER TABLE iam.refresh_tokens ADD CONSTRAINT refresh_tokens_hash_key UNIQUE (hash);
ALTER TABLE iam.api_tokens ADD CONSTRAINT api_tokens_pkey PRIMARY KEY (id);
ALTER TABLE iam.api_tokens ADD CONSTRAINT api_tokens_hash_key UNIQUE (hash);
ALTER TABLE iam.ssh_public_keys ADD CONSTRAINT ssh_public_keys_pkey PRIMARY KEY (id);
ALTER TABLE iam.ssh_public_keys ADD CONSTRAINT ssh_public_keys_user_id_fingerprint_key
    UNIQUE (user_id, fingerprint);

ALTER TABLE infra.shared_backends ADD CONSTRAINT shared_backends_identity_key_key
    UNIQUE (identity_key);
CREATE UNIQUE INDEX shared_backends_ceph_fsid_unique
    ON infra.shared_backends (lower(ceph_fsid));
ALTER TABLE infra.servers ADD CONSTRAINT servers_slug_key UNIQUE (slug);
ALTER TABLE infra.ip_pools ADD CONSTRAINT ip_pools_cidr_key UNIQUE (cidr);
ALTER TABLE infra.ip_pools ADD CONSTRAINT ip_pools_name_key UNIQUE (name);
CREATE INDEX ip_pool_servers_server_idx ON infra.ip_pool_servers (server_id, pool_id);
ALTER TABLE infra.images ADD CONSTRAINT images_name_key UNIQUE (name);
ALTER TABLE infra.images ADD CONSTRAINT images_alias_key UNIQUE (alias);
ALTER TABLE infra.image_server_assignments ADD CONSTRAINT image_server_assignments_pkey
    PRIMARY KEY (id);

ALTER TABLE iam.server_grants ADD CONSTRAINT server_grants_pkey PRIMARY KEY (id);
ALTER TABLE iam.storage_pool_grants ADD CONSTRAINT storage_pool_grants_pkey PRIMARY KEY (id);
ALTER TABLE iam.shared_backend_grants ADD CONSTRAINT shared_backend_grants_pkey PRIMARY KEY (id);

ALTER TABLE control.containers ADD CONSTRAINT containers_server_id_name_key
    UNIQUE (server_id, name);
ALTER TABLE control.volumes ADD CONSTRAINT volumes_incus_name_key UNIQUE (incus_name);
ALTER TABLE control.volume_attachments ADD CONSTRAINT volume_attachments_pkey PRIMARY KEY (id);
ALTER TABLE control.container_network_claims ADD CONSTRAINT container_network_claims_pkey
    PRIMARY KEY (id);
ALTER TABLE control.container_network_claims ADD CONSTRAINT container_network_claims_network_key_address_key
    UNIQUE (network_key, address);
ALTER TABLE control.container_ssh_routes ADD CONSTRAINT container_ssh_routes_pkey
    PRIMARY KEY (container_id);
ALTER TABLE control.authorization_dependencies ADD CONSTRAINT authorization_dependencies_pkey
    PRIMARY KEY (id);
ALTER TABLE control.authorization_dependencies ADD CONSTRAINT authorization_dependencies_unique
    UNIQUE (dependency_kind, dependency_id, user_id);
ALTER TABLE control.grant_expiry_enforcement ADD CONSTRAINT grant_expiry_enforcement_pkey
    PRIMARY KEY (user_id, server_id, covering_expires_at);
ALTER TABLE control.intents ADD CONSTRAINT intents_pkey PRIMARY KEY (id);
ALTER TABLE control.intents ADD CONSTRAINT intents_blocked_by_intent_id_fkey
    FOREIGN KEY (blocked_by_intent_id) REFERENCES control.intents(id) ON DELETE SET NULL;

ALTER TABLE system.settings ADD CONSTRAINT settings_pkey PRIMARY KEY (singleton);
ALTER TABLE interaction.http_domain_pools ADD CONSTRAINT http_domain_pools_wildcard_domain_key
    UNIQUE (wildcard_domain);
ALTER TABLE interaction.http_hostname_reservations ADD CONSTRAINT http_hostname_reservations_pkey
    PRIMARY KEY (hostname);
ALTER TABLE interaction.http_proxy_bindings ADD CONSTRAINT http_proxy_bindings_pkey
    PRIMARY KEY (id);
ALTER TABLE interaction.http_proxy_bindings ADD CONSTRAINT http_proxy_bindings_hostname_key
    UNIQUE (hostname);
ALTER TABLE interaction.http_proxy_snapshot_state ADD CONSTRAINT http_proxy_snapshot_state_pkey
    PRIMARY KEY (singleton);

CREATE UNIQUE INDEX image_server_assignments_unique
    ON infra.image_server_assignments (image_id, server_id);
CREATE INDEX image_server_assignments_server_phase_idx
    ON infra.image_server_assignments (server_id, lifecycle_phase);
CREATE INDEX images_catalog_idx
    ON infra.images (is_active, deleting, name, id);
CREATE UNIQUE INDEX storage_pools_server_name_unique
    ON infra.storage_pools (server_id, incus_name);
CREATE UNIQUE INDEX storage_pools_shared_backend_server_unique
    ON infra.storage_pools (shared_backend_id, server_id)
    WHERE shared_backend_id IS NOT NULL AND shareable = true;
CREATE INDEX storage_pools_server_registered_idx
    ON infra.storage_pools (server_id, registered, incus_name);
CREATE INDEX storage_pools_shared_backend_fk_idx
    ON infra.storage_pools (shared_backend_id);
CREATE INDEX shared_backends_name_idx
    ON infra.shared_backends (name, id);
CREATE INDEX servers_name_idx ON infra.servers (name, id);
CREATE INDEX servers_status_idx ON infra.servers (status);
CREATE INDEX servers_node_metrics_status_idx ON infra.servers (node_metrics_status);
CREATE INDEX servers_preflight_status_idx ON infra.servers (preflight_status);
CREATE INDEX servers_system_pool_idx ON infra.servers (system_pool_id);

CREATE UNIQUE INDEX server_grants_user_unique
    ON iam.server_grants (user_id, server_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX server_grants_group_unique
    ON iam.server_grants (group_id, server_id) WHERE group_id IS NOT NULL;
CREATE INDEX server_grants_user_idx ON iam.server_grants (user_id);
CREATE INDEX server_grants_group_idx ON iam.server_grants (group_id);
CREATE INDEX server_grants_server_idx ON iam.server_grants (server_id);
CREATE INDEX server_grants_expires_at_idx
    ON iam.server_grants (expires_at) WHERE expires_at IS NOT NULL;
CREATE UNIQUE INDEX storage_pool_grants_user_unique
    ON iam.storage_pool_grants (user_id, pool_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX storage_pool_grants_group_unique
    ON iam.storage_pool_grants (group_id, pool_id) WHERE group_id IS NOT NULL;
CREATE INDEX storage_pool_grants_user_idx ON iam.storage_pool_grants (user_id);
CREATE INDEX storage_pool_grants_group_idx ON iam.storage_pool_grants (group_id);
CREATE INDEX storage_pool_grants_pool_idx ON iam.storage_pool_grants (pool_id);
CREATE INDEX storage_pool_grants_expires_at_idx
    ON iam.storage_pool_grants (expires_at) WHERE expires_at IS NOT NULL;
CREATE UNIQUE INDEX shared_backend_grants_user_unique
    ON iam.shared_backend_grants (user_id, shared_backend_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX shared_backend_grants_group_unique
    ON iam.shared_backend_grants (group_id, shared_backend_id) WHERE group_id IS NOT NULL;
CREATE INDEX shared_backend_grants_user_idx ON iam.shared_backend_grants (user_id);
CREATE INDEX shared_backend_grants_group_idx ON iam.shared_backend_grants (group_id);
CREATE INDEX shared_backend_grants_backend_idx
    ON iam.shared_backend_grants (shared_backend_id);
CREATE INDEX shared_backend_grants_expires_at_idx
    ON iam.shared_backend_grants (expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX containers_image_idx ON control.containers (image_id);
CREATE INDEX containers_owner_idx ON control.containers (owner_id, created_at DESC, id);
CREATE INDEX containers_server_idx ON control.containers (server_id, created_at DESC, id);
CREATE INDEX containers_created_by_idx ON control.containers (created_by);
CREATE INDEX containers_root_pool_idx ON control.containers (root_pool_id);
CREATE INDEX containers_attention_idx
    ON control.containers (server_id, needs_attention) WHERE needs_attention;
CREATE UNIQUE INDEX volumes_local_name_unique
    ON control.volumes (owner_id, server_id, name) WHERE server_id IS NOT NULL;
CREATE UNIQUE INDEX volumes_shared_name_unique
    ON control.volumes (owner_id, shared_backend_id, name)
    WHERE shared_backend_id IS NOT NULL;
CREATE INDEX volumes_owner_idx ON control.volumes (owner_id, created_at DESC, id);
CREATE INDEX volumes_pool_idx ON control.volumes (pool_id, lifecycle_phase, id);
CREATE INDEX volumes_server_idx ON control.volumes (server_id);
CREATE INDEX volumes_shared_backend_fk_idx ON control.volumes (shared_backend_id);
CREATE INDEX volumes_shared_backend_idx
    ON control.volumes (shared_backend_id, lifecycle_phase, id)
    WHERE shared_backend_id IS NOT NULL;
CREATE INDEX volumes_remove_all_server_fk_idx
    ON control.volumes (remove_all_server_id);
CREATE INDEX volume_attachments_container_idx
    ON control.volume_attachments (container_id, id);
CREATE INDEX volume_attachments_volume_idx
    ON control.volume_attachments (volume_id, id);
CREATE UNIQUE INDEX volume_attachments_path_unique
    ON control.volume_attachments (container_id, container_path);
CREATE UNIQUE INDEX volume_attachments_pair_unique
    ON control.volume_attachments (container_id, volume_id);
CREATE INDEX volume_placements_server_idx
    ON control.volume_placements (server_id, catalog_state);
CREATE INDEX volume_placements_volume_idx
    ON control.volume_placements (volume_id);
CREATE INDEX volume_placements_pool_fk_idx
    ON control.volume_placements (pool_id);
CREATE INDEX container_network_claims_reusable_idx
    ON control.container_network_claims (reusable_at, id) WHERE state = 'releasing';
CREATE INDEX container_network_claims_server_idx
    ON control.container_network_claims (server_id, state);
CREATE INDEX container_network_claims_container_fk_idx
    ON control.container_network_claims (container_id);
CREATE UNIQUE INDEX container_network_claims_container_owner_idx
    ON control.container_network_claims (container_id)
    WHERE owner_kind = 'container' AND container_id IS NOT NULL;
CREATE UNIQUE INDEX container_network_claims_owner_idx
    ON control.container_network_claims (owner_kind, owner_id);
CREATE INDEX extension_device_claims_server_idx
    ON control.extension_device_claims (server_id, extension_id, device_key);
CREATE INDEX extension_device_claims_container_idx
    ON control.extension_device_claims (container_id);
CREATE INDEX server_extensions_enabled_idx
    ON infra.server_extensions (extension_id)
    WHERE enabled;
CREATE INDEX container_ssh_routes_ip_idx
    ON control.container_ssh_routes (routed_ip);
CREATE INDEX container_ssh_routes_server_idx
    ON control.container_ssh_routes (server_id);
CREATE INDEX authorization_dependencies_server_idx
    ON control.authorization_dependencies (user_id, server_id)
    WHERE server_id IS NOT NULL;
CREATE INDEX authorization_dependencies_pool_idx
    ON control.authorization_dependencies (user_id, pool_id)
    WHERE pool_id IS NOT NULL;
CREATE INDEX authorization_dependencies_backend_idx
    ON control.authorization_dependencies (user_id, shared_backend_id)
    WHERE shared_backend_id IS NOT NULL;
CREATE INDEX authorization_dependencies_server_fk_idx
    ON control.authorization_dependencies (server_id);
CREATE INDEX authorization_dependencies_pool_fk_idx
    ON control.authorization_dependencies (pool_id);
CREATE INDEX authorization_dependencies_backend_fk_idx
    ON control.authorization_dependencies (shared_backend_id);
CREATE INDEX authorization_dependencies_user_fk_idx
    ON control.authorization_dependencies (user_id);
CREATE INDEX grant_expiry_enforcement_pending_idx
    ON control.grant_expiry_enforcement (user_id, server_id)
    WHERE grace_stopped_at IS NULL OR purged_at IS NULL;
CREATE INDEX grant_expiry_enforcement_lease_idx
    ON control.grant_expiry_enforcement (lease_expires_at)
    WHERE claim_token IS NOT NULL;
CREATE INDEX grant_expiry_enforcement_server_idx
    ON control.grant_expiry_enforcement (server_id);
CREATE INDEX intents_pending_ready_idx
    ON control.intents ((COALESCE(next_attempt_at, created_at)) ASC, created_at ASC, id ASC)
    WHERE status = 'pending';
CREATE INDEX intents_pending_resource_idx
    ON control.intents (resource_type, resource_id, target_generation, created_at ASC, id ASC)
    WHERE status = 'pending';
CREATE INDEX intents_blocked_by_idx
    ON control.intents (blocked_by_intent_id);
CREATE INDEX intents_history_idx
    ON control.intents (resource_type, resource_id, created_at DESC, id DESC);
CREATE INDEX intents_server_idx
    ON control.intents (server_id, created_at DESC, id DESC)
    WHERE server_id IS NOT NULL;
CREATE INDEX intents_server_fk_idx ON control.intents (server_id);
CREATE INDEX intents_requested_by_idx ON control.intents (requested_by);
CREATE INDEX intents_retention_idx
    ON control.intents (created_at, id) WHERE status <> 'pending';
CREATE INDEX reconcile_claims_lease_idx ON control.reconcile_claims (lease_expires_at);
CREATE INDEX reconcile_claims_server_idx ON control.reconcile_claims (server_id);

CREATE INDEX iam_api_tokens_user_created_idx
    ON iam.api_tokens (user_id, created_at DESC, id);
CREATE INDEX iam_group_members_user_idx ON iam.group_members (user_id, group_id);
CREATE INDEX iam_groups_priority_name_idx ON iam.groups (priority DESC, name);
CREATE INDEX refresh_tokens_expiry_idx ON iam.refresh_tokens (expires_at);
CREATE INDEX refresh_tokens_revoked_idx ON iam.refresh_tokens (id) WHERE revoked;
CREATE INDEX iam_refresh_tokens_user_active_idx
    ON iam.refresh_tokens (user_id, created_at, id) WHERE NOT revoked;
CREATE INDEX iam_refresh_tokens_user_idx ON iam.refresh_tokens (user_id);
CREATE UNIQUE INDEX iam_refresh_tokens_previous_hash_unique
    ON iam.refresh_tokens (previous_hash) WHERE previous_hash IS NOT NULL;
CREATE INDEX iam_ssh_public_keys_user_idx
    ON iam.ssh_public_keys (user_id, created_at, id);
CREATE INDEX iam_users_status_idx ON iam.users (status, username);

CREATE UNIQUE INDEX incus_client_certificates_generation_unique
    ON system.incus_client_certificates (generation);
CREATE UNIQUE INDEX incus_client_certificates_active_unique
    ON system.incus_client_certificates (state) WHERE state = 'active';
CREATE INDEX incus_client_certificates_created_by_idx
    ON system.incus_client_certificates (created_by);
CREATE INDEX incus_client_certificate_trusts_server_idx
    ON system.incus_client_certificate_trusts (server_id, state);
CREATE INDEX settings_updated_by_idx ON system.settings (updated_by);
CREATE UNIQUE INDEX http_hostname_active_binding_idx
    ON interaction.http_hostname_reservations (binding_id) WHERE state = 'active';
CREATE INDEX http_hostname_owner_idx
    ON interaction.http_hostname_reservations (owner_id);
CREATE INDEX http_hostname_reusable_idx
    ON interaction.http_hostname_reservations (reusable_at, hostname)
    WHERE state = 'releasing';
CREATE INDEX http_proxy_bindings_container_idx
    ON interaction.http_proxy_bindings (container_id, id);
CREATE INDEX http_proxy_bindings_owner_idx
    ON interaction.http_proxy_bindings (owner_id, hostname, id);
CREATE INDEX http_proxy_bindings_pool_idx
    ON interaction.http_proxy_bindings (domain_pool_id, id);

CREATE FUNCTION audit.reject_event_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION iam.bump_policy_epoch() RETURNS bigint
    LANGUAGE sql
    AS $$
  UPDATE iam.policy_state
  SET policy_epoch = policy_epoch + 1,
      updated_at = clock_timestamp()
  WHERE singleton
  RETURNING policy_epoch
$$;

COMMENT ON FUNCTION iam.bump_policy_epoch() IS
  'Durable authorization cache fence; external publication is only a wake-up optimization';

CREATE FUNCTION iam.lock_policy_state_before_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM 1 FROM iam.policy_state WHERE singleton = true FOR UPDATE;
  RETURN NULL;
END;
$$;

CREATE FUNCTION iam.touch_authorization_subjects() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.user_id IS NOT NULL THEN
      UPDATE iam.users
      SET authz_version = authz_version + 1, updated_at = clock_timestamp()
      WHERE id = OLD.user_id;
    END IF;
    IF OLD.group_id IS NOT NULL THEN
      UPDATE iam.users AS users
      SET authz_version = users.authz_version + 1, updated_at = clock_timestamp()
      FROM iam.group_members AS members
      WHERE members.group_id = OLD.group_id AND members.user_id = users.id;
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    IF NEW.user_id IS NOT NULL THEN
      UPDATE iam.users
      SET authz_version = authz_version + 1, updated_at = clock_timestamp()
      WHERE id = NEW.user_id;
    END IF;
    IF NEW.group_id IS NOT NULL THEN
      UPDATE iam.users AS users
      SET authz_version = users.authz_version + 1, updated_at = clock_timestamp()
      FROM iam.group_members AS members
      WHERE members.group_id = NEW.group_id AND members.user_id = users.id;
    END IF;
  END IF;

  PERFORM iam.bump_policy_epoch();
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION iam.touch_group_authorization() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.capabilities IS DISTINCT FROM NEW.capabilities
    OR OLD.priority IS DISTINCT FROM NEW.priority
  THEN
    UPDATE iam.users AS users
    SET auth_version = users.auth_version + 1,
        authz_version = users.authz_version + 1,
        updated_at = clock_timestamp()
    FROM iam.group_members AS members
    WHERE members.group_id = NEW.id AND members.user_id = users.id;
    PERFORM iam.bump_policy_epoch();
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION iam.touch_membership_authorization() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  affected_user_id uuid;
BEGIN
  affected_user_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  UPDATE iam.users
  SET auth_version = auth_version + 1,
      authz_version = authz_version + 1,
      updated_at = clock_timestamp()
  WHERE id = affected_user_id;
  PERFORM iam.bump_policy_epoch();
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION iam.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION infra.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION control.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION control.release_extension_device_claims_on_terminal_phase() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.lifecycle_phase = ANY (ARRAY['failed', 'deleting'])
     AND OLD.lifecycle_phase IS DISTINCT FROM NEW.lifecycle_phase THEN
    DELETE FROM control.extension_device_claims WHERE container_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION infra.reject_disable_extension_with_claims() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.enabled = false AND OLD.enabled IS DISTINCT FROM false THEN
    IF EXISTS (
      SELECT 1 FROM control.extension_device_claims
      WHERE server_id = NEW.server_id AND extension_id = NEW.extension_id
    ) THEN
      RAISE EXCEPTION 'server extension % is occupied', NEW.extension_id
        USING ERRCODE = 'P0001',
              HINT = 'EXTENSION_OCCUPIED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION infra.reject_delete_extension_with_claims() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM control.extension_device_claims
    WHERE server_id = OLD.server_id AND extension_id = OLD.extension_id
  ) THEN
    RAISE EXCEPTION 'server extension % is occupied', OLD.extension_id
      USING ERRCODE = 'P0001', HINT = 'EXTENSION_OCCUPIED';
  END IF;
  RETURN OLD;
END;
$$;

CREATE FUNCTION control.assert_volume_placement_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  vol record;
  pool record;
BEGIN
  SELECT server_id, shared_backend_id, pool_id INTO vol
    FROM control.volumes WHERE id = NEW.volume_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'volume placement volume does not exist'
      USING ERRCODE = '23514', CONSTRAINT = 'volume_placements_scope';
  END IF;
  SELECT server_id, shared_backend_id, driver, shareable, registered INTO pool
    FROM infra.storage_pools WHERE id = NEW.pool_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'volume placement pool does not exist'
      USING ERRCODE = '23514', CONSTRAINT = 'volume_placements_scope';
  END IF;
  IF pool.server_id IS DISTINCT FROM NEW.server_id THEN
    RAISE EXCEPTION 'volume placement pool is not on the placement server'
      USING ERRCODE = '23514', CONSTRAINT = 'volume_placements_scope';
  END IF;
  IF vol.shared_backend_id IS NOT NULL THEN
    IF pool.shared_backend_id IS DISTINCT FROM vol.shared_backend_id
       OR pool.driver <> 'cephfs'
       OR pool.shareable IS NOT TRUE
       OR pool.registered IS NOT TRUE THEN
      RAISE EXCEPTION 'shared volume placement pool must be a registered shareable cephfs pool for this backend'
        USING ERRCODE = '23514', CONSTRAINT = 'volume_placements_scope';
    END IF;
  ELSE
    IF NEW.pool_id IS DISTINCT FROM vol.pool_id
       OR vol.server_id IS DISTINCT FROM NEW.server_id THEN
      RAISE EXCEPTION 'local volume placement must use the volume pool on the volume server'
        USING ERRCODE = '23514', CONSTRAINT = 'volume_placements_scope';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION control.reject_container_identity_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.server_id IS DISTINCT FROM NEW.server_id
    OR OLD.owner_id IS DISTINCT FROM NEW.owner_id
    OR OLD.image_id IS DISTINCT FROM NEW.image_id
    OR OLD.created_by IS DISTINCT FROM NEW.created_by
  THEN
    RAISE EXCEPTION 'container identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'containers_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION control.sync_container_authorization_dependency() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM control.authorization_dependencies
    WHERE dependency_kind = 'container'
      AND dependency_id = OLD.id
      AND user_id = OLD.owner_id;
    RETURN OLD;
  END IF;

  INSERT INTO control.authorization_dependencies (
    id, dependency_kind, dependency_id, user_id, server_id, pool_id, shared_backend_id
  ) VALUES (
    gen_random_uuid(), 'container', NEW.id, NEW.owner_id, NEW.server_id, NULL, NULL
  )
  ON CONFLICT (dependency_kind, dependency_id, user_id)
  DO UPDATE SET server_id = EXCLUDED.server_id, pool_id = NULL, shared_backend_id = NULL;
  RETURN NEW;
END;
$$;

CREATE FUNCTION control.sync_volume_authorization_dependency() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM control.authorization_dependencies
    WHERE dependency_kind = 'volume'
      AND dependency_id = OLD.id
      AND user_id = OLD.owner_id;
    RETURN OLD;
  END IF;

  INSERT INTO control.authorization_dependencies (
    id, dependency_kind, dependency_id, user_id, server_id, pool_id, shared_backend_id
  ) VALUES (
    gen_random_uuid(), 'volume', NEW.id, NEW.owner_id, NEW.server_id,
    CASE WHEN NEW.server_id IS NOT NULL THEN NEW.pool_id ELSE NULL END,
    NEW.shared_backend_id
  )
  ON CONFLICT (dependency_kind, dependency_id, user_id)
  DO UPDATE SET
    server_id = EXCLUDED.server_id,
    pool_id = EXCLUDED.pool_id,
    shared_backend_id = EXCLUDED.shared_backend_id;
  RETURN NEW;
END;
$$;

CREATE FUNCTION control.sync_volume_attachment_authorization_dependency() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  attachment_user_id uuid;
  attachment_server_id uuid;
  volume_server_id uuid;
  attachment_pool_id uuid;
  attachment_backend_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM control.authorization_dependencies
    WHERE dependency_kind = 'volume_attachment' AND dependency_id = OLD.id;
    RETURN OLD;
  END IF;

  SELECT containers.owner_id, containers.server_id,
         volumes.server_id, volumes.pool_id, volumes.shared_backend_id
  INTO attachment_user_id, attachment_server_id, volume_server_id,
       attachment_pool_id, attachment_backend_id
  FROM control.volume_attachments AS attachments
  JOIN control.containers AS containers ON containers.id = attachments.container_id
  JOIN control.volumes AS volumes ON volumes.id = attachments.volume_id
  WHERE attachments.id = NEW.id;

  INSERT INTO control.authorization_dependencies (
    id, dependency_kind, dependency_id, user_id, server_id, pool_id, shared_backend_id
  ) VALUES (
    gen_random_uuid(), 'volume_attachment', NEW.id, attachment_user_id,
    CASE WHEN attachment_backend_id IS NULL THEN attachment_server_id ELSE NULL END,
    CASE WHEN attachment_backend_id IS NULL THEN attachment_pool_id ELSE NULL END,
    attachment_backend_id
  )
  ON CONFLICT (dependency_kind, dependency_id, user_id)
  DO UPDATE SET
    server_id = EXCLUDED.server_id,
    pool_id = EXCLUDED.pool_id,
    shared_backend_id = EXCLUDED.shared_backend_id;
  RETURN NEW;
END;
$$;

CREATE FUNCTION control.assert_server_system_pool_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  pool_server_id uuid;
  pool_root_capable boolean;
  pool_registered boolean;
BEGIN
  IF NEW.system_pool_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT server_id, root_disk_capable, registered
  INTO pool_server_id, pool_root_capable, pool_registered
  FROM infra.storage_pools
  WHERE id = NEW.system_pool_id;
  IF pool_server_id IS DISTINCT FROM NEW.id
    OR NOT COALESCE(pool_root_capable, false)
    OR NOT COALESCE(pool_registered, false)
  THEN
    RAISE EXCEPTION 'system pool must be a root-capable pool on the same server'
      USING ERRCODE = '23514', CONSTRAINT = 'servers_system_pool_scope';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION control.assert_container_root_pool_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  pool_server_id uuid;
  pool_root_capable boolean;
BEGIN
  SELECT server_id, root_disk_capable
  INTO pool_server_id, pool_root_capable
  FROM infra.storage_pools
  WHERE id = NEW.root_pool_id;
  IF pool_server_id IS DISTINCT FROM NEW.server_id OR NOT COALESCE(pool_root_capable, false)
    OR NOT EXISTS (
      SELECT 1
      FROM infra.storage_pools AS pools
      WHERE pools.id = NEW.root_pool_id
        AND pools.registered
    )
  THEN
    RAISE EXCEPTION 'container root pool must be root-capable on the container server'
      USING ERRCODE = '23514', CONSTRAINT = 'containers_root_pool_scope';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION control.assert_volume_pool_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  pool_server_id uuid;
  pool_backend_id uuid;
  pool_registered boolean;
BEGIN
  IF NEW.pool_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT server_id, shared_backend_id, registered
  INTO pool_server_id, pool_backend_id, pool_registered
  FROM infra.storage_pools
  WHERE id = NEW.pool_id;

  IF NEW.server_id IS NOT NULL THEN
    IF pool_server_id IS DISTINCT FROM NEW.server_id
      OR pool_backend_id IS NOT NULL
      OR NOT COALESCE(pool_registered, false)
    THEN
      RAISE EXCEPTION 'local volume pool must belong to its volume server'
        USING ERRCODE = '23514', CONSTRAINT = 'volumes_local_pool_scope';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION control.assert_volume_attachment_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  container_owner_id uuid;
  container_server_id uuid;
  volume_owner_id uuid;
  volume_server_id uuid;
  volume_pool_id uuid;
  volume_backend_id uuid;
BEGIN
  SELECT containers.owner_id, containers.server_id
  INTO container_owner_id, container_server_id
  FROM control.containers AS containers
  WHERE containers.id = NEW.container_id;

  SELECT volumes.owner_id, volumes.server_id, volumes.pool_id, volumes.shared_backend_id
  INTO volume_owner_id, volume_server_id, volume_pool_id, volume_backend_id
  FROM control.volumes AS volumes
  WHERE volumes.id = NEW.volume_id;

  IF container_owner_id IS DISTINCT FROM volume_owner_id THEN
    RAISE EXCEPTION 'volume and container owners must match'
      USING ERRCODE = '23514', CONSTRAINT = 'volume_attachments_owner_scope';
  END IF;

  IF volume_backend_id IS NULL THEN
    IF volume_server_id IS DISTINCT FROM container_server_id
      OR NOT EXISTS (
        SELECT 1
        FROM infra.storage_pools AS pools
        WHERE pools.id = volume_pool_id
          AND pools.server_id = container_server_id
          AND pools.registered
      )
    THEN
      RAISE EXCEPTION 'local volume must attach on its pool server'
        USING ERRCODE = '23514', CONSTRAINT = 'volume_attachments_local_server_scope';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM infra.storage_pools AS pools
    WHERE pools.shared_backend_id = volume_backend_id
      AND pools.server_id = container_server_id
      AND pools.driver = 'cephfs'
      AND pools.shareable
      AND pools.registered
  ) THEN
    RAISE EXCEPTION 'shared backend is not visible on the container server'
      USING ERRCODE = '23514', CONSTRAINT = 'volume_attachments_backend_visibility';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION control.touch_volume_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION control.set_network_claim_drain() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  drain_deadline timestamp with time zone;
BEGIN
  IF NEW.state = 'active' THEN
    NEW.reusable_at := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM 'releasing' THEN
    drain_deadline := clock_timestamp() + interval '360 seconds';
    NEW.reusable_at := GREATEST(COALESCE(NEW.reusable_at, drain_deadline), drain_deadline);
  ELSIF OLD.reusable_at IS NOT NULL
    AND (NEW.reusable_at IS NULL OR NEW.reusable_at < OLD.reusable_at)
  THEN
    NEW.reusable_at := OLD.reusable_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION control.assert_storage_pool_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.registered = false
    AND EXISTS (
      SELECT 1
      FROM control.containers
      WHERE root_pool_id = NEW.id
        AND lifecycle_phase NOT IN ('failed', 'deleting')
    )
  THEN
    RAISE EXCEPTION 'storage pool cannot be unregistered while it has active root disks'
      USING ERRCODE = '23514', CONSTRAINT = 'storage_pool_registration_dependencies';
  END IF;

  IF (
    OLD.shared_backend_id IS DISTINCT FROM NEW.shared_backend_id
    OR OLD.registered IS DISTINCT FROM NEW.registered
  )
    AND (
      EXISTS (SELECT 1 FROM control.volumes WHERE pool_id = NEW.id)
      OR EXISTS (SELECT 1 FROM infra.servers WHERE system_pool_id = NEW.id)
      OR EXISTS (SELECT 1 FROM iam.storage_pool_grants WHERE pool_id = NEW.id)
    )
  THEN
    IF OLD.shared_backend_id IS DISTINCT FROM NEW.shared_backend_id
      OR NEW.registered = false
    THEN
      RAISE EXCEPTION 'storage pool mapping or registration cannot change while referenced'
        USING ERRCODE = '23514', CONSTRAINT = 'storage_pool_mutation_dependencies';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION interaction.drain_http_binding_hostname() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE interaction.http_hostname_reservations
  SET state = 'releasing',
      binding_id = NULL,
      reusable_at = clock_timestamp() + interval '360 seconds',
      release_generation = release_generation + 1
  WHERE hostname = OLD.hostname
    AND owner_id = OLD.owner_id
    AND binding_id = OLD.id
    AND state = 'active';
  RETURN OLD;
END;
$$;

CREATE FUNCTION interaction.touch_http_hostname_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION interaction.touch_http_proxy_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  IF NEW IS DISTINCT FROM OLD AND NEW.revision = OLD.revision THEN
    NEW.revision := OLD.revision + 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_events_reject_update
BEFORE UPDATE ON audit.events
FOR EACH ROW EXECUTE FUNCTION audit.reject_event_update();

CREATE TRIGGER users_authorization_barrier
BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON iam.users
FOR EACH STATEMENT EXECUTE FUNCTION iam.lock_policy_state_before_mutation();
CREATE TRIGGER groups_authorization_barrier
BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON iam.groups
FOR EACH STATEMENT EXECUTE FUNCTION iam.lock_policy_state_before_mutation();
CREATE TRIGGER group_members_authorization_barrier
BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON iam.group_members
FOR EACH STATEMENT EXECUTE FUNCTION iam.lock_policy_state_before_mutation();
CREATE TRIGGER server_grants_authorization_barrier
BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON iam.server_grants
FOR EACH STATEMENT EXECUTE FUNCTION iam.lock_policy_state_before_mutation();
CREATE TRIGGER storage_pool_grants_authorization_barrier
BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON iam.storage_pool_grants
FOR EACH STATEMENT EXECUTE FUNCTION iam.lock_policy_state_before_mutation();
CREATE TRIGGER shared_backend_grants_authorization_barrier
BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON iam.shared_backend_grants
FOR EACH STATEMENT EXECUTE FUNCTION iam.lock_policy_state_before_mutation();

CREATE TRIGGER groups_authorization_touch
AFTER UPDATE OF capabilities, priority ON iam.groups
FOR EACH ROW EXECUTE FUNCTION iam.touch_group_authorization();
CREATE TRIGGER group_members_authorization_touch
AFTER INSERT OR DELETE ON iam.group_members
FOR EACH ROW EXECUTE FUNCTION iam.touch_membership_authorization();
CREATE TRIGGER server_grants_authorization_touch
AFTER INSERT OR DELETE OR UPDATE ON iam.server_grants
FOR EACH ROW EXECUTE FUNCTION iam.touch_authorization_subjects();
CREATE TRIGGER storage_pool_grants_authorization_touch
AFTER INSERT OR DELETE OR UPDATE ON iam.storage_pool_grants
FOR EACH ROW EXECUTE FUNCTION iam.touch_authorization_subjects();
CREATE TRIGGER shared_backend_grants_authorization_touch
AFTER INSERT OR DELETE OR UPDATE ON iam.shared_backend_grants
FOR EACH ROW EXECUTE FUNCTION iam.touch_authorization_subjects();

CREATE TRIGGER iam_groups_touch_updated_at
BEFORE UPDATE ON iam.groups
FOR EACH ROW EXECUTE FUNCTION iam.touch_updated_at();
CREATE TRIGGER iam_users_touch_updated_at
BEFORE UPDATE ON iam.users
FOR EACH ROW EXECUTE FUNCTION iam.touch_updated_at();
CREATE TRIGGER iam_server_grants_touch_updated_at
BEFORE UPDATE ON iam.server_grants
FOR EACH ROW EXECUTE FUNCTION iam.touch_updated_at();
CREATE TRIGGER iam_storage_pool_grants_touch_updated_at
BEFORE UPDATE ON iam.storage_pool_grants
FOR EACH ROW EXECUTE FUNCTION iam.touch_updated_at();
CREATE TRIGGER iam_shared_backend_grants_touch_updated_at
BEFORE UPDATE ON iam.shared_backend_grants
FOR EACH ROW EXECUTE FUNCTION iam.touch_updated_at();

CREATE TRIGGER servers_touch_updated_at
BEFORE UPDATE ON infra.servers
FOR EACH ROW EXECUTE FUNCTION infra.touch_updated_at();
CREATE TRIGGER ip_pools_touch_updated_at
BEFORE UPDATE ON infra.ip_pools
FOR EACH ROW EXECUTE FUNCTION infra.touch_updated_at();
CREATE TRIGGER shared_backends_touch_updated_at
BEFORE UPDATE ON infra.shared_backends
FOR EACH ROW EXECUTE FUNCTION infra.touch_updated_at();
CREATE TRIGGER storage_pools_touch_updated_at
BEFORE UPDATE ON infra.storage_pools
FOR EACH ROW EXECUTE FUNCTION infra.touch_updated_at();
CREATE TRIGGER storage_pools_mutation_guard
BEFORE UPDATE OF registered, shared_backend_id ON infra.storage_pools
FOR EACH ROW EXECUTE FUNCTION control.assert_storage_pool_mutation();
CREATE TRIGGER images_touch_updated_at
BEFORE UPDATE ON infra.images
FOR EACH ROW EXECUTE FUNCTION infra.touch_updated_at();
CREATE TRIGGER image_assignments_touch_updated_at
BEFORE UPDATE ON infra.image_server_assignments
FOR EACH ROW EXECUTE FUNCTION infra.touch_updated_at();

CREATE TRIGGER containers_identity_immutable
BEFORE UPDATE OF server_id, owner_id, image_id, created_by ON control.containers
FOR EACH ROW EXECUTE FUNCTION control.reject_container_identity_change();
CREATE TRIGGER containers_touch_updated_at
BEFORE UPDATE ON control.containers
FOR EACH ROW EXECUTE FUNCTION control.touch_updated_at();
CREATE TRIGGER containers_release_extension_device_claims
AFTER UPDATE OF lifecycle_phase ON control.containers
FOR EACH ROW EXECUTE FUNCTION control.release_extension_device_claims_on_terminal_phase();
CREATE TRIGGER server_extensions_touch_updated_at
BEFORE UPDATE ON infra.server_extensions
FOR EACH ROW EXECUTE FUNCTION infra.touch_updated_at();
CREATE TRIGGER server_extensions_reject_occupied_disable
BEFORE UPDATE OF enabled ON infra.server_extensions
FOR EACH ROW EXECUTE FUNCTION infra.reject_disable_extension_with_claims();
CREATE TRIGGER server_extensions_reject_occupied_delete
BEFORE DELETE ON infra.server_extensions
FOR EACH ROW EXECUTE FUNCTION infra.reject_delete_extension_with_claims();
CREATE TRIGGER volumes_touch_updated_at
BEFORE UPDATE ON control.volumes
FOR EACH ROW EXECUTE FUNCTION control.touch_updated_at();
CREATE TRIGGER volume_placements_touch_updated_at
BEFORE UPDATE ON control.volume_placements
FOR EACH ROW EXECUTE FUNCTION control.touch_updated_at();
CREATE CONSTRAINT TRIGGER volume_placements_scope
AFTER INSERT OR UPDATE OF volume_id, server_id, pool_id ON control.volume_placements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION control.assert_volume_placement_scope();
CREATE TRIGGER volume_attachments_touch_updated_at
BEFORE UPDATE ON control.volume_attachments
FOR EACH ROW EXECUTE FUNCTION control.touch_updated_at();
CREATE TRIGGER container_network_claims_touch_updated_at
BEFORE UPDATE ON control.container_network_claims
FOR EACH ROW EXECUTE FUNCTION control.touch_updated_at();
CREATE TRIGGER container_network_claims_drain_window
BEFORE INSERT OR UPDATE OF state, reusable_at ON control.container_network_claims
FOR EACH ROW EXECUTE FUNCTION control.set_network_claim_drain();
CREATE TRIGGER grant_expiry_enforcement_touch_updated_at
BEFORE UPDATE ON control.grant_expiry_enforcement
FOR EACH ROW EXECUTE FUNCTION control.touch_updated_at();

CREATE TRIGGER containers_authorization_dependency
AFTER INSERT OR DELETE OR UPDATE OF owner_id, server_id ON control.containers
FOR EACH ROW EXECUTE FUNCTION control.sync_container_authorization_dependency();
CREATE TRIGGER volumes_authorization_dependency
AFTER INSERT OR DELETE OR UPDATE OF owner_id, server_id, pool_id, shared_backend_id
ON control.volumes
FOR EACH ROW EXECUTE FUNCTION control.sync_volume_authorization_dependency();
CREATE TRIGGER volume_attachments_authorization_dependency
AFTER INSERT OR DELETE OR UPDATE OF container_id, volume_id
ON control.volume_attachments
FOR EACH ROW EXECUTE FUNCTION control.sync_volume_attachment_authorization_dependency();

CREATE CONSTRAINT TRIGGER servers_system_pool_scope
AFTER INSERT OR UPDATE OF id, system_pool_id ON infra.servers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION control.assert_server_system_pool_scope();
CREATE CONSTRAINT TRIGGER containers_root_pool_scope
AFTER INSERT OR UPDATE OF server_id, root_pool_id ON control.containers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION control.assert_container_root_pool_scope();
CREATE CONSTRAINT TRIGGER volumes_pool_scope
AFTER INSERT OR UPDATE OF server_id, pool_id, shared_backend_id ON control.volumes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION control.assert_volume_pool_scope();
CREATE CONSTRAINT TRIGGER volume_attachments_scope
AFTER INSERT OR UPDATE OF container_id, volume_id ON control.volume_attachments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION control.assert_volume_attachment_scope();

CREATE TRIGGER http_domain_pools_touch_updated_at
BEFORE UPDATE ON interaction.http_domain_pools
FOR EACH ROW EXECUTE FUNCTION interaction.touch_http_proxy_updated_at();
CREATE TRIGGER http_hostname_reservations_touch_updated_at
BEFORE UPDATE ON interaction.http_hostname_reservations
FOR EACH ROW EXECUTE FUNCTION interaction.touch_http_hostname_updated_at();
CREATE TRIGGER http_proxy_bindings_drain_hostname
BEFORE DELETE ON interaction.http_proxy_bindings
FOR EACH ROW EXECUTE FUNCTION interaction.drain_http_binding_hostname();
CREATE TRIGGER http_proxy_bindings_touch_updated_at
BEFORE UPDATE ON interaction.http_proxy_bindings
FOR EACH ROW EXECUTE FUNCTION interaction.touch_http_proxy_updated_at();
