--
-- Nyabase PostgreSQL initial schema.
-- Fresh installations only; previous PostgreSQL manifests and SQLite are intentionally unsupported.

SET LOCAL check_function_bodies = false;
--




--
-- Name: audit; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA audit;


--
-- Name: SCHEMA audit; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA audit IS 'Append-only audit events with bounded retention';


--
-- Name: control; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA control;


--
-- Name: SCHEMA control; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA control IS 'Desired state and authoritative control-plane projections';


--
-- Name: iam; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA iam;


--
-- Name: SCHEMA iam; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA iam IS 'Identity, authentication, authorization, and grants';


--
-- Name: infra; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA infra;


--
-- Name: SCHEMA infra; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA infra IS 'Managed servers, images, networks, and storage catalog';


--
-- Name: interaction; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA interaction;


--
-- Name: system; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS system;


--
-- Name: workflow; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA workflow;


--
-- Name: SCHEMA workflow; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA workflow IS 'Durable Agent commands, attempts, resource claims, and outbox';


--
-- Name: reject_event_update(); Type: FUNCTION; Schema: audit; Owner: -
--

CREATE FUNCTION audit.reject_event_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only'
    USING ERRCODE = '55000';
END;
$$;


--
-- Name: reject_container_identity_change(); Type: FUNCTION; Schema: control; Owner: -
--

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
      USING ERRCODE = '23514',
            CONSTRAINT = 'containers_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: require_remote_storage_source(); Type: FUNCTION; Schema: control; Owner: -
--

CREATE FUNCTION control.require_remote_storage_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.source_kind = 'remote'
    AND NOT EXISTS (
      SELECT 1
      FROM infra.remote_fs_mounts
      WHERE id = NEW.source_id::uuid
    )
  THEN
    RAISE EXCEPTION 'remote data directory source does not exist'
      USING ERRCODE = '23503',
            CONSTRAINT = 'data_directories_remote_source_fkey';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'remote data directory source must be a UUID'
      USING ERRCODE = '23514',
            CONSTRAINT = 'data_directories_remote_source_uuid_check';
END;
$$;


--
-- Name: sync_container_authorization_dependency(); Type: FUNCTION; Schema: control; Owner: -
--

CREATE FUNCTION control.sync_container_authorization_dependency() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM control.authorization_dependencies
    WHERE dependency_kind = 'container'
      AND dependency_id = OLD.id::text
      AND user_id = OLD.owner_id;
    RETURN OLD;
  END IF;

  INSERT INTO control.authorization_dependencies (
    id, dependency_kind, dependency_id, user_id, server_id,
    source_kind, source_id, source_identity
  ) VALUES (
    gen_random_uuid(), 'container', NEW.id::text, NEW.owner_id,
    NEW.server_id::text, NULL, NULL, NULL
  )
  ON CONFLICT (dependency_kind, dependency_id, user_id)
  DO UPDATE SET server_id = EXCLUDED.server_id;
  RETURN NEW;
END;
$$;


--
-- Name: sync_container_mount_authorization_dependency(); Type: FUNCTION; Schema: control; Owner: -
--

CREATE FUNCTION control.sync_container_mount_authorization_dependency() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM control.authorization_dependencies
    WHERE dependency_kind = 'container_mount'
      AND dependency_id = OLD.id::text
      AND user_id = OLD.user_id;
    RETURN OLD;
  END IF;

  INSERT INTO control.authorization_dependencies (
    id, dependency_kind, dependency_id, user_id, server_id,
    source_kind, source_id, source_identity
  ) VALUES (
    gen_random_uuid(), 'container_mount', NEW.id::text, NEW.user_id,
    NEW.server_id::text, NEW.source_kind, NEW.source_id,
    CASE WHEN NEW.source_kind = 'local' THEN NEW.source_identity ELSE NULL END
  )
  ON CONFLICT (dependency_kind, dependency_id, user_id)
  DO UPDATE SET
    server_id = EXCLUDED.server_id,
    source_kind = EXCLUDED.source_kind,
    source_id = EXCLUDED.source_id,
    source_identity = EXCLUDED.source_identity;
  RETURN NEW;
END;
$$;


--
-- Name: touch_container_updated_at(); Type: FUNCTION; Schema: control; Owner: -
--

CREATE FUNCTION control.touch_container_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;


--
-- Name: touch_storage_updated_at(); Type: FUNCTION; Schema: control; Owner: -
--

CREATE FUNCTION control.touch_storage_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;


--
-- Name: bump_policy_epoch(); Type: FUNCTION; Schema: iam; Owner: -
--

CREATE FUNCTION iam.bump_policy_epoch() RETURNS bigint
    LANGUAGE sql
    AS $$
  UPDATE iam.policy_state
  SET policy_epoch = policy_epoch + 1,
      updated_at = clock_timestamp()
  WHERE singleton
  RETURNING policy_epoch
$$;


--
-- Name: FUNCTION bump_policy_epoch(); Type: COMMENT; Schema: iam; Owner: -
--

COMMENT ON FUNCTION iam.bump_policy_epoch() IS 'Durable cross-process authorization cache fence; Redis publication is only a wake-up optimization';


--
-- Name: lock_policy_state_before_mutation(); Type: FUNCTION; Schema: iam; Owner: -
--

CREATE FUNCTION iam.lock_policy_state_before_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM 1
  FROM iam.policy_state
  WHERE singleton = true
  FOR UPDATE;
  RETURN NULL;
END;
$$;


--
-- Name: require_remote_mount_source(); Type: FUNCTION; Schema: iam; Owner: -
--

CREATE FUNCTION iam.require_remote_mount_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.source_kind = 'remote'
    AND NOT EXISTS (
      SELECT 1
      FROM infra.remote_fs_mounts
      WHERE id = NEW.source_id::uuid
    )
  THEN
    RAISE EXCEPTION 'remote mount source does not exist'
      USING ERRCODE = '23503',
            CONSTRAINT = 'mount_source_grants_remote_source_fkey';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'remote mount source must be a UUID'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mount_source_grants_remote_source_uuid_check';
END;
$$;


--
-- Name: touch_authorization_subjects(); Type: FUNCTION; Schema: iam; Owner: -
--

CREATE FUNCTION iam.touch_authorization_subjects() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  affected_user_id uuid;
  affected_group_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    affected_user_id := OLD.user_id;
    affected_group_id := OLD.group_id;
  ELSE
    affected_user_id := NEW.user_id;
    affected_group_id := NEW.group_id;
  END IF;

  IF affected_user_id IS NOT NULL THEN
    UPDATE iam.users
    SET authz_version = authz_version + 1,
        updated_at = clock_timestamp()
    WHERE id = affected_user_id;
  END IF;

  IF affected_group_id IS NOT NULL THEN
    UPDATE iam.users AS users
    SET authz_version = users.authz_version + 1,
        updated_at = clock_timestamp()
    FROM iam.group_members AS members
    WHERE members.group_id = affected_group_id
      AND members.user_id = users.id;
  END IF;

  PERFORM iam.bump_policy_epoch();
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: touch_group_authorization(); Type: FUNCTION; Schema: iam; Owner: -
--

CREATE FUNCTION iam.touch_group_authorization() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.capabilities IS DISTINCT FROM NEW.capabilities THEN
    UPDATE iam.users AS users
    SET auth_version = users.auth_version + 1,
        authz_version = users.authz_version + 1,
        updated_at = clock_timestamp()
    FROM iam.group_members AS members
    WHERE members.group_id = NEW.id
      AND members.user_id = users.id;
  ELSIF OLD.priority IS DISTINCT FROM NEW.priority THEN
    UPDATE iam.users AS users
    SET authz_version = users.authz_version + 1,
        updated_at = clock_timestamp()
    FROM iam.group_members AS members
    WHERE members.group_id = NEW.id
      AND members.user_id = users.id;
  ELSE
    RETURN NEW;
  END IF;

  PERFORM iam.bump_policy_epoch();
  RETURN NEW;
END;
$$;


--
-- Name: touch_membership_authorization(); Type: FUNCTION; Schema: iam; Owner: -
--

CREATE FUNCTION iam.touch_membership_authorization() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  affected_user_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    affected_user_id := OLD.user_id;
  ELSE
    affected_user_id := NEW.user_id;
  END IF;
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


--
-- Name: reject_image_reference_change(); Type: FUNCTION; Schema: infra; Owner: -
--

CREATE FUNCTION infra.reject_image_reference_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.docker_image IS DISTINCT FROM NEW.docker_image THEN
    RAISE EXCEPTION 'docker image reference is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'images_docker_image_immutable';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: touch_storage_updated_at(); Type: FUNCTION; Schema: infra; Owner: -
--

CREATE FUNCTION infra.touch_storage_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;


--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: infra; Owner: -
--

CREATE FUNCTION infra.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;


--
-- Name: drain_http_binding_hostname(); Type: FUNCTION; Schema: interaction; Owner: -
--

CREATE FUNCTION interaction.drain_http_binding_hostname() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE interaction.http_hostname_reservations
  SET state = 'releasing',
      binding_id = NULL,
      -- Keep this in sync with CONTAINER_DELETE_PROXY_DRAIN_MS (360 seconds).
      reusable_at = clock_timestamp() + interval '360 seconds',
      release_generation = release_generation + 1
  WHERE hostname = OLD.hostname
    AND owner_id = OLD.owner_id
    AND binding_id = OLD.id
    AND state = 'active';
  RETURN OLD;
END;
$$;


--
-- Name: touch_http_hostname_updated_at(); Type: FUNCTION; Schema: interaction; Owner: -
--

CREATE FUNCTION interaction.touch_http_hostname_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;


--
-- Name: touch_http_proxy_updated_at(); Type: FUNCTION; Schema: interaction; Owner: -
--

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


--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: workflow; Owner: -
--

CREATE FUNCTION workflow.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;




--
-- Name: events; Type: TABLE; Schema: audit; Owner: -
--

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
    CONSTRAINT audit_actor_snapshot_object CHECK (((actor_snapshot IS NULL) OR (jsonb_typeof(actor_snapshot) = 'object'::text))),
    CONSTRAINT audit_target_snapshot_object CHECK (((target_snapshot IS NULL) OR (jsonb_typeof(target_snapshot) = 'object'::text))),
    CONSTRAINT events_action_check CHECK ((((length(action) >= 1) AND (length(action) <= 128)) AND (action = lower(action)))),
    CONSTRAINT events_related_check CHECK ((jsonb_typeof(related) = 'array'::text))
);


--
-- Name: TABLE events; Type: COMMENT; Schema: audit; Owner: -
--

COMMENT ON TABLE audit.events IS 'Append-only control-plane audit facts; DELETE is reserved for configured retention';


--
-- Name: COLUMN events.actor_snapshot; Type: COMMENT; Schema: audit; Owner: -
--

COMMENT ON COLUMN audit.events.actor_snapshot IS 'Immutable actor identity snapshot captured in the same transaction as the event';


--
-- Name: COLUMN events.detail; Type: COMMENT; Schema: audit; Owner: -
--

COMMENT ON COLUMN audit.events.detail IS 'Sanitized event detail; credential-like fields are redacted before insertion';


--
-- Name: authorization_dependencies; Type: TABLE; Schema: control; Owner: -
--

CREATE TABLE control.authorization_dependencies (
    id uuid NOT NULL,
    dependency_kind text NOT NULL,
    dependency_id text NOT NULL,
    user_id uuid NOT NULL,
    server_id text NOT NULL,
    source_kind text,
    source_id text,
    source_identity text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT authorization_dependencies_dependency_id_check CHECK ((length(btrim(dependency_id)) > 0)),
    CONSTRAINT authorization_dependencies_dependency_kind_check CHECK ((dependency_kind = ANY (ARRAY['container'::text, 'data_directory'::text, 'container_mount'::text]))),
    CONSTRAINT authorization_dependencies_server_id_check CHECK ((length(btrim(server_id)) > 0)),
    CONSTRAINT authorization_dependencies_source_kind_check CHECK (((source_kind IS NULL) OR (source_kind = ANY (ARRAY['local'::text, 'remote'::text])))),
    CONSTRAINT authorization_dependencies_source_shape_check CHECK ((((source_kind IS NULL) AND (source_id IS NULL) AND (source_identity IS NULL)) OR ((source_kind = 'remote'::text) AND (source_id IS NOT NULL) AND (source_identity IS NULL)) OR ((source_kind = 'local'::text) AND (source_id IS NOT NULL) AND (source_identity IS NOT NULL) AND (length(btrim(source_identity)) > 0))))
);


--
-- Name: TABLE authorization_dependencies; Type: COMMENT; Schema: control; Owner: -
--

COMMENT ON TABLE control.authorization_dependencies IS 'Transactional projection used to reject grant revocation while retained control resources still depend on it';


--
-- Name: container_gpu_claims; Type: TABLE; Schema: control; Owner: -
--

CREATE TABLE control.container_gpu_claims (
    id uuid NOT NULL,
    container_id uuid NOT NULL,
    server_id uuid NOT NULL,
    gpu_index integer NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT container_gpu_claims_gpu_index_check CHECK ((gpu_index >= 0))
);


--
-- Name: container_mounts; Type: TABLE; Schema: control; Owner: -
--

CREATE TABLE control.container_mounts (
    id uuid NOT NULL,
    container_id uuid NOT NULL,
    server_id uuid NOT NULL,
    resource_id uuid NOT NULL,
    source_kind text NOT NULL,
    source_id text NOT NULL,
    source_identity text NOT NULL,
    user_id uuid NOT NULL,
    dir_name text NOT NULL,
    container_path text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT container_mounts_container_path_check CHECK (((container_path ~~ '/%'::text) AND (container_path <> '/'::text) AND (container_path !~ '[\000\r\n]'::text))),
    CONSTRAINT container_mounts_dir_name_check CHECK ((length(btrim(dir_name)) > 0)),
    CONSTRAINT container_mounts_source_id_check CHECK ((length(btrim(source_id)) > 0)),
    CONSTRAINT container_mounts_source_identity_check CHECK ((length(btrim(source_identity)) > 0)),
    CONSTRAINT container_mounts_source_kind_check CHECK ((source_kind = ANY (ARRAY['local'::text, 'remote'::text])))
);


--
-- Name: container_network_claims; Type: TABLE; Schema: control; Owner: -
--

CREATE TABLE control.container_network_claims (
    id uuid NOT NULL,
    container_id uuid,
    server_id uuid NOT NULL,
    network_key cidr NOT NULL,
    address inet NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    reusable_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    owner_kind text NOT NULL,
    owner_id text NOT NULL,
    cleanup_payload_json jsonb,
    CONSTRAINT container_network_claim_address_shape_check CHECK (((family((network_key)::inet) = family(address)) AND (address <<= (network_key)::inet))),
    CONSTRAINT container_network_claim_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['container'::text, 'runtime_cleanup'::text]))),
    CONSTRAINT container_network_claim_owner_shape_check CHECK ((((owner_kind = 'container'::text) AND (owner_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND (cleanup_payload_json IS NULL) AND (((state = 'active'::text) AND (container_id IS NOT NULL) AND (owner_id = (container_id)::text)) OR (state = 'releasing'::text))) OR ((owner_kind = 'runtime_cleanup'::text) AND (container_id IS NULL) AND (length(btrim(owner_id)) > 0) AND (jsonb_typeof(cleanup_payload_json) = 'object'::text)))),
    CONSTRAINT container_network_claim_state_shape_check CHECK ((((state = 'active'::text) AND (reusable_at IS NULL)) OR ((state = 'releasing'::text) AND (reusable_at IS NOT NULL)))),
    CONSTRAINT container_network_claims_state_check CHECK ((state = ANY (ARRAY['active'::text, 'releasing'::text])))
);


--
-- Name: COLUMN container_network_claims.owner_id; Type: COMMENT; Schema: control; Owner: -
--

COMMENT ON COLUMN control.container_network_claims.owner_id IS 'Stable owner retained after a container aggregate is deleted; runtime cleanup uses the immutable runtime id';


--
-- Name: COLUMN container_network_claims.cleanup_payload_json; Type: COMMENT; Schema: control; Owner: -
--

COMMENT ON COLUMN control.container_network_claims.cleanup_payload_json IS 'Exact signed runtime-absent identity; null for ordinary container reservations';


--
-- Name: container_ssh_routes; Type: TABLE; Schema: control; Owner: -
--

CREATE TABLE control.container_ssh_routes (
    container_id uuid NOT NULL,
    server_id uuid NOT NULL,
    runtime_id text NOT NULL,
    macvlan_ip inet,
    runtime_status text NOT NULL,
    ssh_status text NOT NULL,
    applied_internal_key_generation integer,
    container_host_key_fingerprint text,
    last_error text,
    observed_at timestamp with time zone NOT NULL,
    CONSTRAINT container_ssh_routes_applied_internal_key_generation_check CHECK (((applied_internal_key_generation IS NULL) OR (applied_internal_key_generation > 0))),
    CONSTRAINT container_ssh_routes_runtime_id_check CHECK ((length(btrim(runtime_id)) > 0)),
    CONSTRAINT container_ssh_routes_ssh_status_check CHECK ((ssh_status = ANY (ARRAY['disabled'::text, 'container_stopped'::text, 'running'::text, 'error'::text, 'unknown'::text])))
);


--
-- Name: containers; Type: TABLE; Schema: control; Owner: -
--

CREATE TABLE control.containers (
    id uuid NOT NULL,
    server_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    image_id uuid NOT NULL,
    created_by uuid NOT NULL,
    name text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    desired_generation integer DEFAULT 1 NOT NULL,
    image_ref text NOT NULL,
    image_default_uid integer DEFAULT 0 NOT NULL,
    image_runtime_overrides jsonb DEFAULT '{"cmd": null, "uid": 0, "init": false, "entrypoint": null}'::jsonb NOT NULL,
    cpu_millis integer DEFAULT 0 NOT NULL,
    mem_bytes bigint DEFAULT 0 NOT NULL,
    disk_bytes bigint DEFAULT 0 NOT NULL,
    gpu_mode text DEFAULT 'none'::text NOT NULL,
    gpu_indices integer[] DEFAULT '{}'::integer[] NOT NULL,
    mounts_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    power_intent text DEFAULT 'running'::text NOT NULL,
    lifecycle_phase text DEFAULT 'provisioning'::text NOT NULL,
    observed_generation integer,
    bound_runtime_id text,
    quota_paths text[] DEFAULT '{}'::text[] NOT NULL,
    runtime_spec_hash text,
    active_task_id uuid,
    last_transition_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    failure_reason text,
    failure_code text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT containers_cpu_millis_check CHECK ((cpu_millis >= 0)),
    CONSTRAINT containers_desired_generation_check CHECK ((desired_generation > 0)),
    CONSTRAINT containers_disk_bytes_check CHECK ((disk_bytes >= 0)),
    CONSTRAINT containers_gpu_indices_check CHECK ((array_position(gpu_indices, NULL::integer) IS NULL)),
    CONSTRAINT containers_gpu_mode_check CHECK ((gpu_mode = ANY (ARRAY['none'::text, 'indices'::text, 'all'::text]))),
    CONSTRAINT containers_gpu_shape_check CHECK ((((gpu_mode = 'none'::text) AND (cardinality(gpu_indices) = 0)) OR (gpu_mode = 'all'::text) OR ((gpu_mode = 'indices'::text) AND (cardinality(gpu_indices) > 0)))),
    CONSTRAINT containers_image_default_uid_check CHECK ((image_default_uid >= 0)),
    CONSTRAINT containers_image_ref_check CHECK ((length(btrim(image_ref)) > 0)),
    CONSTRAINT containers_image_runtime_overrides_check CHECK ((jsonb_typeof(image_runtime_overrides) = 'object'::text)),
    CONSTRAINT containers_lifecycle_phase_check CHECK ((lifecycle_phase = ANY (ARRAY['provisioning'::text, 'active'::text, 'updating'::text, 'deleting'::text, 'failed'::text]))),
    CONSTRAINT containers_mem_bytes_check CHECK ((mem_bytes >= 0)),
    CONSTRAINT containers_mounts_json_check CHECK ((jsonb_typeof(mounts_json) = 'array'::text)),
    CONSTRAINT containers_name_check CHECK ((((length(name) >= 1) AND (length(name) <= 64)) AND (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'::text))),
    CONSTRAINT containers_observed_generation_check CHECK (((observed_generation IS NULL) OR (observed_generation > 0))),
    CONSTRAINT containers_power_intent_check CHECK ((power_intent = ANY (ARRAY['running'::text, 'stopped'::text]))),
    CONSTRAINT containers_quota_paths_check CHECK ((array_position(quota_paths, NULL::text) IS NULL)),
    CONSTRAINT containers_revision_check CHECK ((revision > 0)),
    CONSTRAINT containers_runtime_cleanup_shape_check CHECK ((((bound_runtime_id IS NULL) AND (runtime_spec_hash IS NULL) AND (cardinality(quota_paths) = 0)) OR ((bound_runtime_id IS NOT NULL) AND (runtime_spec_hash IS NOT NULL) AND (cardinality(quota_paths) = 2))))
);


--
-- Name: TABLE containers; Type: COMMENT; Schema: control; Owner: -
--

COMMENT ON TABLE control.containers IS 'Canonical Container aggregate root containing identity, desired state, lifecycle and optimistic revision';


--
-- Name: data_directories; Type: TABLE; Schema: control; Owner: -
--

CREATE TABLE control.data_directories (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    source_kind text NOT NULL,
    source_id text NOT NULL,
    remote_fs_mount_id uuid GENERATED ALWAYS AS (
CASE
    WHEN (source_kind = 'remote'::text) THEN (source_id)::uuid
    ELSE NULL::uuid
END) STORED,
    name text NOT NULL,
    source_identity text NOT NULL,
    server_id uuid,
    uid integer DEFAULT 1000 NOT NULL,
    desired_state text DEFAULT 'creating'::text NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    last_task_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT data_directories_desired_state_check CHECK ((desired_state = ANY (ARRAY['creating'::text, 'active'::text, 'removing'::text, 'failed'::text]))),
    CONSTRAINT data_directories_generation_check CHECK ((generation > 0)),
    CONSTRAINT data_directories_name_check CHECK ((length(btrim(name)) > 0)),
    CONSTRAINT data_directories_source_id_check CHECK ((length(btrim(source_id)) > 0)),
    CONSTRAINT data_directories_source_identity_check CHECK ((length(btrim(source_identity)) > 0)),
    CONSTRAINT data_directories_source_kind_check CHECK ((source_kind = ANY (ARRAY['local'::text, 'remote'::text]))),
    CONSTRAINT data_directories_source_shape_check CHECK ((((source_kind = 'local'::text) AND (server_id IS NOT NULL)) OR ((source_kind = 'remote'::text) AND (server_id IS NULL)))),
    CONSTRAINT data_directories_uid_check CHECK ((uid >= 0))
);


--
-- Name: TABLE data_directories; Type: COMMENT; Schema: control; Owner: -
--

COMMENT ON TABLE control.data_directories IS 'Durable per-user storage directory reservations and Agent convergence state';


--
-- Name: quota_desired; Type: TABLE; Schema: control; Owner: -
--

CREATE TABLE control.quota_desired (
    id uuid NOT NULL,
    server_id uuid NOT NULL,
    user_id uuid NOT NULL,
    numeric_user_id integer NOT NULL,
    limit_bytes bigint DEFAULT 0 NOT NULL,
    source text DEFAULT 'grant'::text NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    last_task_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT quota_desired_generation_check CHECK ((generation > 0)),
    CONSTRAINT quota_desired_limit_bytes_check CHECK ((limit_bytes >= 0)),
    CONSTRAINT quota_desired_numeric_user_id_check CHECK ((numeric_user_id > 0)),
    CONSTRAINT quota_desired_source_check CHECK ((source = 'grant'::text))
);


--
-- Name: TABLE quota_desired; Type: COMMENT; Schema: control; Owner: -
--

COMMENT ON TABLE control.quota_desired IS 'Latest durable per-server user quota generation';


--
-- Name: api_tokens; Type: TABLE; Schema: iam; Owner: -
--

CREATE TABLE iam.api_tokens (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    hash character(64) NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT api_tokens_hash_check CHECK ((hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT api_tokens_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 128)))
);


--
-- Name: group_members; Type: TABLE; Schema: iam; Owner: -
--

CREATE TABLE iam.group_members (
    id uuid NOT NULL,
    group_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: groups; Type: TABLE; Schema: iam; Owner: -
--

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
    CONSTRAINT groups_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 128))),
    CONSTRAINT groups_revision_check CHECK ((revision >= 1)),
    CONSTRAINT groups_system_identity_check CHECK (((is_system AND (system_key IS NOT NULL)) OR ((NOT is_system) AND (system_key IS NULL))))
);


--
-- Name: image_grants; Type: TABLE; Schema: iam; Owner: -
--

CREATE TABLE iam.image_grants (
    id uuid NOT NULL,
    user_id uuid,
    group_id uuid,
    image_id text NOT NULL,
    server_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT image_grants_image_id_check CHECK ((length(btrim(image_id)) > 0)),
    CONSTRAINT image_grants_scope_check CHECK (((((user_id IS NOT NULL))::integer + ((group_id IS NOT NULL))::integer) = 1)),
    CONSTRAINT image_grants_server_id_check CHECK ((length(btrim(server_id)) > 0))
);


--
-- Name: mount_source_grants; Type: TABLE; Schema: iam; Owner: -
--

CREATE TABLE iam.mount_source_grants (
    id uuid NOT NULL,
    user_id uuid,
    group_id uuid,
    source_kind text NOT NULL,
    source_id text NOT NULL,
    server_id text,
    source_identity text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    remote_fs_mount_id uuid GENERATED ALWAYS AS (
CASE
    WHEN (source_kind = 'remote'::text) THEN (source_id)::uuid
    ELSE NULL::uuid
END) STORED,
    CONSTRAINT mount_source_grants_scope_check CHECK (((((user_id IS NOT NULL))::integer + ((group_id IS NOT NULL))::integer) = 1)),
    CONSTRAINT mount_source_grants_shape_check CHECK ((((source_kind = 'local'::text) AND (server_id IS NOT NULL) AND (source_identity IS NOT NULL) AND (length(btrim(source_identity)) > 0)) OR ((source_kind = 'remote'::text) AND (server_id IS NULL) AND (source_identity IS NULL)))),
    CONSTRAINT mount_source_grants_source_id_check CHECK ((length(btrim(source_id)) > 0)),
    CONSTRAINT mount_source_grants_source_kind_check CHECK ((source_kind = ANY (ARRAY['local'::text, 'remote'::text])))
);


--
-- Name: policy_state; Type: TABLE; Schema: iam; Owner: -
--

CREATE TABLE iam.policy_state (
    singleton boolean DEFAULT true NOT NULL,
    policy_epoch bigint DEFAULT 0 NOT NULL,
    next_numeric_user_id integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT policy_state_next_numeric_user_id_check CHECK (((next_numeric_user_id >= 1) AND (next_numeric_user_id <= 4097))),
    CONSTRAINT policy_state_policy_epoch_check CHECK ((policy_epoch >= 0)),
    CONSTRAINT policy_state_singleton_check CHECK (singleton)
);


--
-- Name: TABLE policy_state; Type: COMMENT; Schema: iam; Owner: -
--

COMMENT ON TABLE iam.policy_state IS 'Singleton serialization point for numeric user allocation and monotonic authorization policy epochs';


--
-- Name: refresh_tokens; Type: TABLE; Schema: iam; Owner: -
--

CREATE TABLE iam.refresh_tokens (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    hash character(64) NOT NULL,
    previous_hash character(64),
    previous_request_id_hash character(64),
    expires_at timestamp with time zone NOT NULL,
    revoked boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT refresh_tokens_hash_check CHECK ((hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT refresh_tokens_predecessor_shape_check CHECK ((((previous_hash IS NULL) AND (previous_request_id_hash IS NULL)) OR ((previous_hash IS NOT NULL) AND (previous_request_id_hash IS NOT NULL))))
);


--
-- Name: COLUMN refresh_tokens.previous_hash; Type: COMMENT; Schema: iam; Owner: -
--

COMMENT ON COLUMN iam.refresh_tokens.previous_hash IS 'One-step predecessor used only for exact response recovery and logout-after-rotation';


--
-- Name: server_grants; Type: TABLE; Schema: iam; Owner: -
--

CREATE TABLE iam.server_grants (
    id uuid NOT NULL,
    user_id uuid,
    group_id uuid,
    server_id text NOT NULL,
    cpu_millis integer,
    mem_bytes bigint,
    disk_bytes bigint,
    gpu_mode text,
    gpu_indices integer[],
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT server_grants_cpu_millis_check CHECK (((cpu_millis IS NULL) OR (cpu_millis >= 0))),
    CONSTRAINT server_grants_disk_bytes_check CHECK (((disk_bytes IS NULL) OR (disk_bytes >= 0))),
    CONSTRAINT server_grants_gpu_mode_check CHECK (((gpu_mode IS NULL) OR (gpu_mode = ANY (ARRAY['all'::text, 'none'::text, 'indices'::text])))),
    CONSTRAINT server_grants_gpu_shape_check CHECK ((((gpu_mode = 'indices'::text) AND (gpu_indices IS NOT NULL)) OR ((gpu_mode IS DISTINCT FROM 'indices'::text) AND (gpu_indices IS NULL)))),
    CONSTRAINT server_grants_mem_bytes_check CHECK (((mem_bytes IS NULL) OR (mem_bytes >= 0))),
    CONSTRAINT server_grants_scope_check CHECK (((((user_id IS NOT NULL))::integer + ((group_id IS NOT NULL))::integer) = 1)),
    CONSTRAINT server_grants_server_id_check CHECK ((length(btrim(server_id)) > 0))
);


--
-- Name: ssh_public_keys; Type: TABLE; Schema: iam; Owner: -
--

CREATE TABLE iam.ssh_public_keys (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    key_text text NOT NULL,
    fingerprint text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ssh_public_keys_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 128)))
);


--
-- Name: user_internal_ssh_keys; Type: TABLE; Schema: iam; Owner: -
--

CREATE TABLE iam.user_internal_ssh_keys (
    user_id uuid NOT NULL,
    encrypted_private_key text NOT NULL,
    public_key text NOT NULL,
    fingerprint text NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    rotated_at timestamp with time zone NOT NULL,
    CONSTRAINT user_internal_ssh_keys_generation_check CHECK ((generation >= 1))
);


--
-- Name: users; Type: TABLE; Schema: iam; Owner: -
--

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
    CONSTRAINT users_auth_version_check CHECK ((auth_version >= 0)),
    CONSTRAINT users_authz_version_check CHECK ((authz_version >= 0)),
    CONSTRAINT users_display_name_check CHECK (((length(btrim(display_name)) >= 1) AND (length(btrim(display_name)) <= 128))),
    CONSTRAINT users_numeric_id_check CHECK (((numeric_id >= 1) AND (numeric_id <= 4096))),
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text, 'deleting'::text, 'deleted'::text]))),
    CONSTRAINT users_username_check CHECK (((username = lower(username)) AND (username ~ '^[a-z0-9_-]{2,64}$'::text)))
);


--
-- Name: COLUMN users.auth_version; Type: COMMENT; Schema: iam; Owner: -
--

COMMENT ON COLUMN iam.users.auth_version IS 'Browser-session generation embedded in access JWTs';


--
-- Name: COLUMN users.authz_version; Type: COMMENT; Schema: iam; Owner: -
--

COMMENT ON COLUMN iam.users.authz_version IS 'Monotonic authorization snapshot version; incremented in the same transaction as membership or grant changes';


--
-- Name: images; Type: TABLE; Schema: infra; Owner: -
--

CREATE TABLE infra.images (
    id uuid NOT NULL,
    name text NOT NULL,
    docker_image text NOT NULL,
    runtime_overrides jsonb DEFAULT '{"cmd": null, "uid": 0, "init": false, "entrypoint": null}'::jsonb NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    disable_ssh boolean DEFAULT false NOT NULL,
    deleting boolean DEFAULT false NOT NULL,
    cleanup_generation integer DEFAULT 0 NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT images_cleanup_generation_check CHECK ((cleanup_generation >= 0)),
    CONSTRAINT images_deleting_shape_check CHECK (((NOT deleting) OR (NOT is_active))),
    CONSTRAINT images_docker_image_check CHECK ((length(btrim(docker_image)) > 0)),
    CONSTRAINT images_name_check CHECK ((length(btrim(name)) > 0)),
    CONSTRAINT images_revision_check CHECK ((revision > 0)),
    CONSTRAINT images_runtime_overrides_check CHECK ((jsonb_typeof(runtime_overrides) = 'object'::text))
);


--
-- Name: TABLE images; Type: COMMENT; Schema: infra; Owner: -
--

COMMENT ON TABLE infra.images IS 'Canonical immutable image reference and optimistic-concurrency lifecycle state';


--
-- Name: remote_fs_mounts; Type: TABLE; Schema: infra; Owner: -
--

CREATE TABLE infra.remote_fs_mounts (
    id uuid NOT NULL,
    name text NOT NULL,
    display_name text,
    description text,
    type text NOT NULL,
    host_mount_point text NOT NULL,
    options text DEFAULT ''::text NOT NULL,
    params jsonb NOT NULL,
    desired_state text DEFAULT 'active'::text NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    last_task_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT remote_fs_mounts_desired_state_check CHECK ((desired_state = ANY (ARRAY['active'::text, 'removing'::text]))),
    CONSTRAINT remote_fs_mounts_generation_check CHECK ((generation > 0)),
    CONSTRAINT remote_fs_mounts_host_path_check CHECK ((host_mount_point = ('/mnt/remote-fs/'::text || (id)::text))),
    CONSTRAINT remote_fs_mounts_name_check CHECK ((length(btrim(name)) > 0)),
    CONSTRAINT remote_fs_mounts_params_check CHECK ((jsonb_typeof(params) = 'object'::text)),
    CONSTRAINT remote_fs_mounts_params_type_check CHECK (((params ->> 'type'::text) = type)),
    CONSTRAINT remote_fs_mounts_type_check CHECK ((type = ANY (ARRAY['nfs'::text, 'cephfs'::text])))
);


--
-- Name: TABLE remote_fs_mounts; Type: COMMENT; Schema: infra; Owner: -
--

COMMENT ON TABLE infra.remote_fs_mounts IS 'Encrypted RemoteFS specifications and desired lifecycle state';


--
-- Name: remote_fs_server_assignments; Type: TABLE; Schema: infra; Owner: -
--

CREATE TABLE infra.remote_fs_server_assignments (
    id uuid NOT NULL,
    remote_fs_mount_id uuid NOT NULL,
    server_id uuid NOT NULL,
    desired_state text DEFAULT 'ensuring'::text NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    last_task_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT remote_fs_server_assignments_desired_state_check CHECK ((desired_state = ANY (ARRAY['ensuring'::text, 'active'::text, 'removing'::text, 'failed'::text]))),
    CONSTRAINT remote_fs_server_assignments_generation_check CHECK ((generation > 0))
);


--
-- Name: TABLE remote_fs_server_assignments; Type: COMMENT; Schema: infra; Owner: -
--

COMMENT ON TABLE infra.remote_fs_server_assignments IS 'Per-server RemoteFS assignment state machine with optimistic generations';


--
-- Name: servers; Type: TABLE; Schema: infra; Owner: -
--

CREATE TABLE infra.servers (
    id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    agent_token_hash text NOT NULL,
    host_fingerprint text,
    agent_config_fingerprint text,
    status text DEFAULT 'unknown'::text NOT NULL,
    quarantine_code text,
    quarantine_message text,
    last_seen_at timestamp with time zone,
    macvlan_cidr text,
    macvlan_gateway text,
    macvlan_reserved_ips jsonb DEFAULT '[]'::jsonb NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT servers_agent_token_hash_check CHECK ((agent_token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT servers_macvlan_reserved_ips_check CHECK ((jsonb_typeof(macvlan_reserved_ips) = 'array'::text)),
    CONSTRAINT servers_name_check CHECK ((length(btrim(name)) > 0)),
    CONSTRAINT servers_quarantine_shape_check CHECK ((((quarantine_code IS NULL) AND (quarantine_message IS NULL)) OR (quarantine_code IS NOT NULL))),
    CONSTRAINT servers_revision_check CHECK ((revision > 0)),
    CONSTRAINT servers_slug_check CHECK (((slug = lower(slug)) AND (slug ~ '^[a-z0-9][a-z0-9_-]*$'::text))),
    CONSTRAINT servers_status_check CHECK ((status = ANY (ARRAY['online'::text, 'offline'::text, 'unknown'::text, 'agent_state_unready'::text, 'agent_quarantined'::text])))
);


--
-- Name: TABLE servers; Type: COMMENT; Schema: infra; Owner: -
--

COMMENT ON TABLE infra.servers IS 'Canonical server identity, Agent admission credential, binding and quarantine state';


--
-- Name: http_domain_pools; Type: TABLE; Schema: interaction; Owner: -
--

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
    CONSTRAINT http_domain_pools_revision_check CHECK ((revision > 0)),
    CONSTRAINT http_domain_pools_tls_shape_check CHECK ((((certificate_pem IS NULL) AND (encrypted_private_key_pem IS NULL) AND (certificate_fingerprint IS NULL) AND (certificate_not_after IS NULL) AND (NOT https_enabled)) OR ((certificate_pem IS NOT NULL) AND (encrypted_private_key_pem IS NOT NULL) AND (certificate_fingerprint IS NOT NULL) AND (certificate_not_after IS NOT NULL)))),
    CONSTRAINT http_domain_pools_wildcard_domain_check CHECK (((wildcard_domain = lower(wildcard_domain)) AND (wildcard_domain ~~ '*.%'::text)))
);


--
-- Name: http_hostname_reservations; Type: TABLE; Schema: interaction; Owner: -
--

CREATE TABLE interaction.http_hostname_reservations (
    hostname text NOT NULL,
    owner_id uuid NOT NULL,
    binding_id uuid,
    state text NOT NULL,
    reusable_at timestamp with time zone,
    release_generation bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT http_hostname_reservation_state_shape_check CHECK ((((state = 'active'::text) AND (binding_id IS NOT NULL) AND (reusable_at IS NULL)) OR ((state = 'releasing'::text) AND (binding_id IS NULL) AND (reusable_at IS NOT NULL) AND (release_generation > 0)))),
    CONSTRAINT http_hostname_reservations_hostname_check CHECK (((hostname = lower(hostname)) AND (hostname !~ '[*]'::text))),
    CONSTRAINT http_hostname_reservations_release_generation_check CHECK ((release_generation >= 0)),
    CONSTRAINT http_hostname_reservations_state_check CHECK ((state = ANY (ARRAY['active'::text, 'releasing'::text])))
);


--
-- Name: TABLE http_hostname_reservations; Type: COMMENT; Schema: interaction; Owner: -
--

COMMENT ON TABLE interaction.http_hostname_reservations IS 'Durable active and draining hostname ownership; reusable_at is authoritative across process crashes';


--
-- Name: COLUMN http_hostname_reservations.release_generation; Type: COMMENT; Schema: interaction; Owner: -
--

COMMENT ON COLUMN interaction.http_hostname_reservations.release_generation IS 'Monotonic durable drain incarnation preventing stale release/reuse work from mutating a newer reservation';


--
-- Name: http_proxy_bindings; Type: TABLE; Schema: interaction; Owner: -
--

CREATE TABLE interaction.http_proxy_bindings (
    id uuid NOT NULL,
    hostname text NOT NULL,
    domain_pool_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    container_id uuid NOT NULL,
    target_port integer NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT http_proxy_bindings_hostname_check CHECK (((hostname = lower(hostname)) AND (hostname !~ '[*]'::text))),
    CONSTRAINT http_proxy_bindings_revision_check CHECK ((revision > 0)),
    CONSTRAINT http_proxy_bindings_target_port_check CHECK (((target_port >= 1) AND (target_port <= 65535)))
);


--
-- Name: http_proxy_snapshot_state; Type: TABLE; Schema: interaction; Owner: -
--

CREATE TABLE interaction.http_proxy_snapshot_state (
    singleton boolean DEFAULT true NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    lease_issued_at timestamp with time zone,
    lease_valid_until timestamp with time zone,
    payload_sha256 character(64),
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT http_proxy_snapshot_lease_shape_check CHECK ((((generation = 0) AND (lease_issued_at IS NULL) AND (lease_valid_until IS NULL) AND (payload_sha256 IS NULL)) OR ((generation > 0) AND (lease_issued_at IS NOT NULL) AND (lease_valid_until IS NOT NULL) AND (lease_valid_until > lease_issued_at) AND (payload_sha256 ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT http_proxy_snapshot_state_generation_check CHECK ((generation >= 0)),
    CONSTRAINT http_proxy_snapshot_state_singleton_check CHECK (singleton)
);


--
-- Name: TABLE http_proxy_snapshot_state; Type: COMMENT; Schema: interaction; Owner: -
--

COMMENT ON TABLE interaction.http_proxy_snapshot_state IS 'Singleton serial-order, generation and last issued lease evidence for authoritative HTTP proxy snapshots';


--
-- Name: ssh_proxy_host_keys; Type: TABLE; Schema: interaction; Owner: -
--

CREATE TABLE interaction.ssh_proxy_host_keys (
    id text NOT NULL,
    encrypted_private_key text NOT NULL,
    public_key text NOT NULL,
    fingerprint text NOT NULL,
    generation integer NOT NULL,
    rotated_at timestamp with time zone NOT NULL,
    CONSTRAINT ssh_proxy_host_keys_generation_check CHECK ((generation >= 1)),
    CONSTRAINT ssh_proxy_host_keys_id_check CHECK ((id = 'singleton'::text))
);


--
-- Name: TABLE ssh_proxy_host_keys; Type: COMMENT; Schema: interaction; Owner: -
--

COMMENT ON TABLE interaction.ssh_proxy_host_keys IS 'Singleton SSH proxy host identity; generation is the compare-and-swap fence for rotations';


--
-- Name: settings; Type: TABLE; Schema: system; Owner: -
--

CREATE TABLE system.settings (
    singleton boolean DEFAULT true NOT NULL,
    revision bigint NOT NULL,
    snapshot_token character(64) NOT NULL,
    "values" jsonb NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT settings_revision_check CHECK (((revision >= 1) AND (revision <= '9007199254740991'::bigint))),
    CONSTRAINT settings_singleton_check CHECK (singleton),
    CONSTRAINT settings_snapshot_token_check CHECK ((snapshot_token ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT settings_values_check CHECK ((jsonb_typeof("values") = 'object'::text))
);


--
-- Name: TABLE settings; Type: COMMENT; Schema: system; Owner: -
--

COMMENT ON TABLE system.settings IS 'PostgreSQL authority for the complete online-editable control-plane settings snapshot';


--
-- Name: COLUMN settings.revision; Type: COMMENT; Schema: system; Owner: -
--

COMMENT ON COLUMN system.settings.revision IS 'Absolute monotonic CAS version consumed by every API, Gateway, and Worker process';


--
-- Name: COLUMN settings.snapshot_token; Type: COMMENT; Schema: system; Owner: -
--

COMMENT ON COLUMN system.settings.snapshot_token IS 'Stable content identity paired with revision for stale-client conflict detection';


--
-- Name: COLUMN settings."values"; Type: COMMENT; Schema: system; Owner: -
--

COMMENT ON COLUMN system.settings."values" IS 'Complete validated online-editable values; deployment YAML is bootstrap/read-only only';


--
-- Name: agent_observations; Type: TABLE; Schema: workflow; Owner: -
--

CREATE TABLE workflow.agent_observations (
    id bigint NOT NULL,
    server_id uuid NOT NULL,
    session_id uuid NOT NULL,
    sequence bigint NOT NULL,
    kind text NOT NULL,
    payload_hash text NOT NULL,
    payload_json jsonb,
    observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT agent_observations_kind_check CHECK ((kind = ANY (ARRAY['hello'::text, 'heartbeat'::text, 'state_report'::text, 'inventory_fault'::text, 'task_result'::text, 'metrics'::text]))),
    CONSTRAINT agent_observations_payload_hash_check CHECK ((payload_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_observations_sequence_check CHECK ((sequence >= 0))
);


--
-- Name: agent_observations_id_seq; Type: SEQUENCE; Schema: workflow; Owner: -
--

ALTER TABLE workflow.agent_observations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME workflow.agent_observations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_runtime_projections; Type: TABLE; Schema: workflow; Owner: -
--

CREATE TABLE workflow.agent_runtime_projections (
    server_id uuid NOT NULL,
    session_id uuid NOT NULL,
    session_generation bigint NOT NULL,
    gateway_id text NOT NULL,
    state_sequence bigint NOT NULL,
    runtime_ready boolean DEFAULT false NOT NULL,
    hello_json jsonb NOT NULL,
    state_report_json jsonb,
    docker_daemon_json jsonb,
    hello_observed_at timestamp with time zone NOT NULL,
    state_observed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT agent_runtime_projections_gateway_id_check CHECK ((length(btrim(gateway_id)) > 0)),
    CONSTRAINT agent_runtime_projections_session_generation_check CHECK ((session_generation > 0)),
    CONSTRAINT agent_runtime_projections_state_sequence_check CHECK ((state_sequence >= 0)),
    CONSTRAINT workflow_agent_runtime_projection_state_shape_check CHECK (((runtime_ready = false) OR ((state_report_json IS NOT NULL) AND (state_observed_at IS NOT NULL))))
);


--
-- Name: agent_sessions; Type: TABLE; Schema: workflow; Owner: -
--

CREATE TABLE workflow.agent_sessions (
    id uuid NOT NULL,
    server_id uuid NOT NULL,
    generation bigint NOT NULL,
    session_token_hash text NOT NULL,
    state text DEFAULT 'admitted'::text NOT NULL,
    host_fingerprint text NOT NULL,
    config_fingerprint text NOT NULL,
    admitted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    ready_at timestamp with time zone,
    last_seen_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    retired_at timestamp with time zone,
    retire_reason text,
    gateway_id text NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    console_public_url text DEFAULT ''::text NOT NULL,
    CONSTRAINT agent_sessions_config_fingerprint_check CHECK ((length(btrim(config_fingerprint)) > 0)),
    CONSTRAINT agent_sessions_console_public_url_bounded CHECK ((octet_length(console_public_url) <= 2048)),
    CONSTRAINT agent_sessions_gateway_id_check CHECK ((length(btrim(gateway_id)) > 0)),
    CONSTRAINT agent_sessions_generation_check CHECK ((generation > 0)),
    CONSTRAINT agent_sessions_host_fingerprint_check CHECK ((length(btrim(host_fingerprint)) > 0)),
    CONSTRAINT agent_sessions_session_token_hash_check CHECK ((session_token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_sessions_state_check CHECK ((state = ANY (ARRAY['admitted'::text, 'ready'::text, 'retired'::text]))),
    CONSTRAINT workflow_agent_session_state_shape_check CHECK ((((state = 'admitted'::text) AND (ready_at IS NULL) AND (retired_at IS NULL)) OR ((state = 'ready'::text) AND (ready_at IS NOT NULL) AND (retired_at IS NULL)) OR ((state = 'retired'::text) AND (retired_at IS NOT NULL))))
);


--
-- Name: commands; Type: TABLE; Schema: workflow; Owner: -
--

CREATE TABLE workflow.commands (
    id uuid NOT NULL,
    kind text NOT NULL,
    server_id uuid NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    requested_by uuid,
    request_json jsonb,
    admission_class text DEFAULT 'normal'::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT commands_admission_class_check CHECK ((admission_class = ANY (ARRAY['normal'::text, 'reconciliation'::text, 'safety'::text]))),
    CONSTRAINT commands_kind_check CHECK ((kind = ANY (ARRAY['container.create'::text, 'container.start'::text, 'container.stop'::text, 'container.restart'::text, 'container.delete'::text, 'container.runtime.absent'::text, 'container.ssh.ensure'::text, 'datadir.ensure'::text, 'datadir.absent'::text, 'remote_fs.ensure'::text, 'remote_fs.absent'::text, 'quota.ensure'::text, 'image.ensure_present'::text, 'image.ensure_absent'::text]))),
    CONSTRAINT commands_resource_id_check CHECK ((length(btrim(resource_id)) > 0)),
    CONSTRAINT commands_resource_type_check CHECK ((length(btrim(resource_type)) > 0))
);


--
-- Name: exec_sessions; Type: TABLE; Schema: workflow; Owner: -
--

CREATE TABLE workflow.exec_sessions (
    id uuid NOT NULL,
    server_id uuid NOT NULL,
    user_id uuid NOT NULL,
    container_id uuid NOT NULL,
    runtime_id text NOT NULL,
    authorization_kind text NOT NULL,
    agent_session_id uuid NOT NULL,
    agent_session_generation bigint NOT NULL,
    gateway_id text NOT NULL,
    state text DEFAULT 'unclaimed'::text NOT NULL,
    claimed_by_gateway_id text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    last_activity_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    closed_at timestamp with time zone,
    close_reason text,
    console_public_url text DEFAULT ''::text NOT NULL,
    CONSTRAINT exec_sessions_agent_session_generation_check CHECK ((agent_session_generation > 0)),
    CONSTRAINT exec_sessions_authorization_kind_check CHECK ((authorization_kind = ANY (ARRAY['container-owner'::text, 'manage-containers-any'::text]))),
    CONSTRAINT exec_sessions_check CHECK ((((state = 'unclaimed'::text) AND (claimed_by_gateway_id IS NULL) AND (closed_at IS NULL)) OR ((state = 'claimed'::text) AND (claimed_by_gateway_id IS NOT NULL) AND (closed_at IS NULL)) OR ((state = 'closed'::text) AND (closed_at IS NOT NULL)))),
    CONSTRAINT exec_sessions_console_public_url_bounded CHECK ((octet_length(console_public_url) <= 2048)),
    CONSTRAINT exec_sessions_gateway_id_check CHECK (((length(gateway_id) >= 1) AND (length(gateway_id) <= 255))),
    CONSTRAINT exec_sessions_runtime_id_check CHECK (((length(runtime_id) >= 1) AND (length(runtime_id) <= 255))),
    CONSTRAINT exec_sessions_state_check CHECK ((state = ANY (ARRAY['unclaimed'::text, 'claimed'::text, 'closed'::text])))
);


--
-- Name: outbox; Type: TABLE; Schema: workflow; Owner: -
--

CREATE TABLE workflow.outbox (
    id bigint NOT NULL,
    topic text NOT NULL,
    partition_key text NOT NULL,
    payload_json jsonb NOT NULL,
    available_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    claim_token uuid,
    claimed_by text,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT outbox_partition_key_check CHECK ((length(btrim(partition_key)) > 0)),
    CONSTRAINT outbox_topic_check CHECK ((length(btrim(topic)) > 0)),
    CONSTRAINT workflow_outbox_claim_shape_check CHECK ((((claim_token IS NULL) AND (claimed_by IS NULL) AND (lease_expires_at IS NULL)) OR ((claim_token IS NOT NULL) AND (claimed_by IS NOT NULL) AND (lease_expires_at IS NOT NULL))))
);


--
-- Name: TABLE outbox; Type: COMMENT; Schema: workflow; Owner: -
--

COMMENT ON TABLE workflow.outbox IS 'Post-commit wake/send intents; transactions never publish Redis or WebSocket messages';


--
-- Name: outbox_id_seq; Type: SEQUENCE; Schema: workflow; Owner: -
--

ALTER TABLE workflow.outbox ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME workflow.outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: reconcile_queue; Type: TABLE; Schema: workflow; Owner: -
--

CREATE TABLE workflow.reconcile_queue (
    id uuid NOT NULL,
    dedupe_key text NOT NULL,
    server_id uuid,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    reason text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    due_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    claim_token uuid,
    claimed_by text,
    lease_expires_at timestamp with time zone,
    last_error_json jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT reconcile_queue_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT reconcile_queue_dedupe_key_check CHECK ((length(btrim(dedupe_key)) > 0)),
    CONSTRAINT reconcile_queue_reason_check CHECK ((length(btrim(reason)) > 0)),
    CONSTRAINT reconcile_queue_resource_id_check CHECK ((length(btrim(resource_id)) > 0)),
    CONSTRAINT reconcile_queue_resource_type_check CHECK ((length(btrim(resource_type)) > 0)),
    CONSTRAINT reconcile_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'claimed'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT workflow_reconcile_claim_shape_check CHECK ((((status = 'claimed'::text) AND (claim_token IS NOT NULL) AND (claimed_by IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR ((status <> 'claimed'::text) AND (claim_token IS NULL) AND (claimed_by IS NULL) AND (lease_expires_at IS NULL))))
);


--
-- Name: resource_claims; Type: TABLE; Schema: workflow; Owner: -
--

CREATE TABLE workflow.resource_claims (
    resource_key text NOT NULL,
    task_id uuid NOT NULL,
    task_generation bigint NOT NULL,
    server_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT resource_claims_resource_key_check CHECK ((length(btrim(resource_key)) > 0)),
    CONSTRAINT resource_claims_task_generation_check CHECK ((task_generation > 0))
);


--
-- Name: TABLE resource_claims; Type: COMMENT; Schema: workflow; Owner: -
--

COMMENT ON TABLE workflow.resource_claims IS 'Retained generation-fenced authority preventing overlapping physical effects';


--
-- Name: server_execution_lanes; Type: TABLE; Schema: workflow; Owner: -
--

CREATE TABLE workflow.server_execution_lanes (
    server_id uuid NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    task_id uuid,
    task_generation bigint,
    claim_token uuid,
    claimed_by text,
    lease_expires_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT server_execution_lanes_generation_check CHECK ((generation >= 0)),
    CONSTRAINT workflow_server_lane_shape_check CHECK ((((task_id IS NULL) AND (task_generation IS NULL) AND (claim_token IS NULL) AND (claimed_by IS NULL) AND (lease_expires_at IS NULL)) OR ((task_id IS NOT NULL) AND (task_generation IS NOT NULL) AND (task_generation > 0) AND (claim_token IS NOT NULL) AND (claimed_by IS NOT NULL) AND (lease_expires_at IS NOT NULL))))
);


--
-- Name: TABLE server_execution_lanes; Type: COMMENT; Schema: workflow; Owner: -
--

COMMENT ON TABLE workflow.server_execution_lanes IS 'Exactly one leased physical execution owner per Server';


--
-- Name: task_attempts; Type: TABLE; Schema: workflow; Owner: -
--

CREATE TABLE workflow.task_attempts (
    id bigint NOT NULL,
    task_id uuid NOT NULL,
    task_generation bigint NOT NULL,
    attempt_no integer NOT NULL,
    claim_token uuid NOT NULL,
    claimed_by text NOT NULL,
    state text DEFAULT 'claimed'::text NOT NULL,
    claimed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    sent_at timestamp with time zone,
    finished_at timestamp with time zone,
    diagnostic_json jsonb,
    agent_session_id uuid NOT NULL,
    agent_session_generation bigint NOT NULL,
    gateway_id text NOT NULL,
    CONSTRAINT task_attempts_agent_session_generation_check CHECK ((agent_session_generation > 0)),
    CONSTRAINT task_attempts_attempt_no_check CHECK ((attempt_no > 0)),
    CONSTRAINT task_attempts_claimed_by_check CHECK ((length(btrim(claimed_by)) > 0)),
    CONSTRAINT task_attempts_gateway_id_check CHECK ((length(btrim(gateway_id)) > 0)),
    CONSTRAINT task_attempts_state_check CHECK ((state = ANY (ARRAY['claimed'::text, 'sent'::text, 'result_received'::text, 'abandoned'::text]))),
    CONSTRAINT task_attempts_task_generation_check CHECK ((task_generation > 0)),
    CONSTRAINT workflow_task_attempt_state_shape_check CHECK ((((state = 'claimed'::text) AND (sent_at IS NULL) AND (finished_at IS NULL)) OR ((state = 'sent'::text) AND (sent_at IS NOT NULL) AND (finished_at IS NULL)) OR ((state = ANY (ARRAY['result_received'::text, 'abandoned'::text])) AND (finished_at IS NOT NULL))))
);


--
-- Name: task_attempts_id_seq; Type: SEQUENCE; Schema: workflow; Owner: -
--

ALTER TABLE workflow.task_attempts ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME workflow.task_attempts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tasks; Type: TABLE; Schema: workflow; Owner: -
--

CREATE TABLE workflow.tasks (
    id uuid NOT NULL,
    command_id uuid NOT NULL,
    kind text NOT NULL,
    server_id uuid NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    requested_by uuid,
    request_json jsonb,
    payload_json jsonb NOT NULL,
    payload_hash text NOT NULL,
    admission_class text DEFAULT 'normal'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    failure_stage text,
    generation bigint DEFAULT 1 NOT NULL,
    agent_result_json jsonb,
    agent_result_hash text,
    result_json jsonb,
    error_json jsonb,
    dispatch_attempt_count integer DEFAULT 0 NOT NULL,
    incomplete_result_count integer DEFAULT 0 NOT NULL,
    finalizer_attempt_count integer DEFAULT 0 NOT NULL,
    retry_window_started_at timestamp with time zone,
    next_dispatch_at timestamp with time zone,
    started_at timestamp with time zone,
    last_sent_at timestamp with time zone,
    result_received_at timestamp with time zone,
    finalizer_retry_at timestamp with time zone,
    completed_at timestamp with time zone,
    dispatch_claim_token uuid,
    dispatch_claimed_by text,
    dispatch_lease_expires_at timestamp with time zone,
    finalizer_claim_token uuid,
    finalizer_claimed_by text,
    finalizer_lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT tasks_admission_class_check CHECK ((admission_class = ANY (ARRAY['normal'::text, 'reconciliation'::text, 'safety'::text]))),
    CONSTRAINT tasks_agent_result_hash_check CHECK (((agent_result_hash IS NULL) OR (agent_result_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT tasks_dispatch_attempt_count_check CHECK ((dispatch_attempt_count >= 0)),
    CONSTRAINT tasks_failure_stage_check CHECK (((failure_stage IS NULL) OR (failure_stage = ANY (ARRAY['dispatch'::text, 'agent'::text, 'finalizer'::text])))),
    CONSTRAINT tasks_finalizer_attempt_count_check CHECK ((finalizer_attempt_count >= 0)),
    CONSTRAINT tasks_generation_check CHECK ((generation > 0)),
    CONSTRAINT tasks_incomplete_result_count_check CHECK ((incomplete_result_count >= 0)),
    CONSTRAINT tasks_kind_check CHECK ((kind = ANY (ARRAY['container.create'::text, 'container.start'::text, 'container.stop'::text, 'container.restart'::text, 'container.delete'::text, 'container.runtime.absent'::text, 'container.ssh.ensure'::text, 'datadir.ensure'::text, 'datadir.absent'::text, 'remote_fs.ensure'::text, 'remote_fs.absent'::text, 'quota.ensure'::text, 'image.ensure_present'::text, 'image.ensure_absent'::text]))),
    CONSTRAINT tasks_payload_hash_check CHECK ((payload_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT tasks_resource_id_check CHECK ((length(btrim(resource_id)) > 0)),
    CONSTRAINT tasks_resource_type_check CHECK ((length(btrim(resource_type)) > 0)),
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text]))),
    CONSTRAINT workflow_task_completion_shape_check CHECK ((((status = 'pending'::text) AND (completed_at IS NULL)) OR ((status = ANY (ARRAY['succeeded'::text, 'failed'::text])) AND (completed_at IS NOT NULL)))),
    CONSTRAINT workflow_task_dispatch_claim_shape_check CHECK ((((dispatch_claim_token IS NULL) AND (dispatch_claimed_by IS NULL) AND (dispatch_lease_expires_at IS NULL)) OR ((dispatch_claim_token IS NOT NULL) AND (dispatch_claimed_by IS NOT NULL) AND (dispatch_lease_expires_at IS NOT NULL) AND (status = 'pending'::text) AND (agent_result_json IS NULL)))),
    CONSTRAINT workflow_task_finalizer_claim_shape_check CHECK ((((finalizer_claim_token IS NULL) AND (finalizer_claimed_by IS NULL) AND (finalizer_lease_expires_at IS NULL)) OR ((finalizer_claim_token IS NOT NULL) AND (finalizer_claimed_by IS NOT NULL) AND (finalizer_lease_expires_at IS NOT NULL) AND (status = 'pending'::text) AND (agent_result_json IS NOT NULL)))),
    CONSTRAINT workflow_task_result_shape_check CHECK ((((agent_result_json IS NULL) AND (agent_result_hash IS NULL) AND (result_received_at IS NULL)) OR ((agent_result_json IS NOT NULL) AND (agent_result_hash IS NOT NULL) AND (result_received_at IS NOT NULL))))
);


--
-- Name: TABLE tasks; Type: COMMENT; Schema: workflow; Owner: -
--

COMMENT ON TABLE workflow.tasks IS 'Canonical Agent task state; terminal Agent evidence is staged before any control-plane finalizer';


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: authorization_dependencies authorization_dependencies_dependency_kind_dependency_id_us_key; Type: CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.authorization_dependencies
    ADD CONSTRAINT authorization_dependencies_dependency_kind_dependency_id_us_key UNIQUE (dependency_kind, dependency_id, user_id);


--
-- Name: authorization_dependencies authorization_dependencies_pkey; Type: CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.authorization_dependencies
    ADD CONSTRAINT authorization_dependencies_pkey PRIMARY KEY (id);


--
-- Name: container_gpu_claims container_gpu_claims_container_id_gpu_index_key; Type: CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_gpu_claims
    ADD CONSTRAINT container_gpu_claims_container_id_gpu_index_key UNIQUE (container_id, gpu_index);


--
-- Name: container_gpu_claims container_gpu_claims_pkey; Type: CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_gpu_claims
    ADD CONSTRAINT container_gpu_claims_pkey PRIMARY KEY (id);


--
-- Name: container_mounts container_mounts_container_id_container_path_key; Type: CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_mounts
    ADD CONSTRAINT container_mounts_container_id_container_path_key UNIQUE (container_id, container_path);


--
-- Name: container_mounts container_mounts_container_id_source_kind_source_id_user_id_key; Type: CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_mounts
    ADD CONSTRAINT container_mounts_container_id_source_kind_source_id_user_id_key UNIQUE (container_id, source_kind, source_id, user_id, dir_name);


--
-- Name: container_mounts container_mounts_pkey; Type: CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_mounts
    ADD CONSTRAINT container_mounts_pkey PRIMARY KEY (id);


--
-- Name: container_network_claims container_network_claims_network_key_address_key; Type: CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_network_claims
    ADD CONSTRAINT container_network_claims_network_key_address_key UNIQUE (network_key, address);


--
-- Name: container_network_claims container_network_claims_pkey; Type: CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_network_claims
    ADD CONSTRAINT container_network_claims_pkey PRIMARY KEY (id);


--
-- Name: container_ssh_routes container_ssh_routes_pkey; Type: CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_ssh_routes
    ADD CONSTRAINT container_ssh_routes_pkey PRIMARY KEY (container_id);


--
-- Name: container_ssh_routes container_ssh_routes_server_id_runtime_id_key; Type: CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_ssh_routes
    ADD CONSTRAINT container_ssh_routes_server_id_runtime_id_key UNIQUE (server_id, runtime_id);


--
-- Name: containers containers_owner_id_server_id_name_key; Type: CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.containers
    ADD CONSTRAINT containers_owner_id_server_id_name_key UNIQUE (owner_id, server_id, name);


--
-- Name: containers containers_pkey; Type: CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.containers
    ADD CONSTRAINT containers_pkey PRIMARY KEY (id);


--
-- Name: data_directories data_directories_pkey; Type: CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.data_directories
    ADD CONSTRAINT data_directories_pkey PRIMARY KEY (id);


--
-- Name: quota_desired quota_desired_pkey; Type: CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.quota_desired
    ADD CONSTRAINT quota_desired_pkey PRIMARY KEY (id);


--
-- Name: quota_desired quota_desired_server_id_user_id_key; Type: CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.quota_desired
    ADD CONSTRAINT quota_desired_server_id_user_id_key UNIQUE (server_id, user_id);


--
-- Name: api_tokens api_tokens_hash_key; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.api_tokens
    ADD CONSTRAINT api_tokens_hash_key UNIQUE (hash);


--
-- Name: api_tokens api_tokens_pkey; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.api_tokens
    ADD CONSTRAINT api_tokens_pkey PRIMARY KEY (id);


--
-- Name: group_members group_members_group_id_user_id_key; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.group_members
    ADD CONSTRAINT group_members_group_id_user_id_key UNIQUE (group_id, user_id);


--
-- Name: group_members group_members_pkey; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.group_members
    ADD CONSTRAINT group_members_pkey PRIMARY KEY (id);


--
-- Name: groups groups_name_key; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.groups
    ADD CONSTRAINT groups_name_key UNIQUE (name);


--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);


--
-- Name: groups groups_system_key_key; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.groups
    ADD CONSTRAINT groups_system_key_key UNIQUE (system_key);


--
-- Name: image_grants image_grants_pkey; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.image_grants
    ADD CONSTRAINT image_grants_pkey PRIMARY KEY (id);


--
-- Name: mount_source_grants mount_source_grants_pkey; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.mount_source_grants
    ADD CONSTRAINT mount_source_grants_pkey PRIMARY KEY (id);


--
-- Name: policy_state policy_state_pkey; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.policy_state
    ADD CONSTRAINT policy_state_pkey PRIMARY KEY (singleton);


--
-- Name: refresh_tokens refresh_tokens_hash_key; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.refresh_tokens
    ADD CONSTRAINT refresh_tokens_hash_key UNIQUE (hash);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: server_grants server_grants_pkey; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.server_grants
    ADD CONSTRAINT server_grants_pkey PRIMARY KEY (id);


--
-- Name: ssh_public_keys ssh_public_keys_pkey; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.ssh_public_keys
    ADD CONSTRAINT ssh_public_keys_pkey PRIMARY KEY (id);


--
-- Name: ssh_public_keys ssh_public_keys_user_id_fingerprint_key; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.ssh_public_keys
    ADD CONSTRAINT ssh_public_keys_user_id_fingerprint_key UNIQUE (user_id, fingerprint);


--
-- Name: user_internal_ssh_keys user_internal_ssh_keys_pkey; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.user_internal_ssh_keys
    ADD CONSTRAINT user_internal_ssh_keys_pkey PRIMARY KEY (user_id);


--
-- Name: users users_numeric_id_key; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.users
    ADD CONSTRAINT users_numeric_id_key UNIQUE (numeric_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: images images_docker_image_key; Type: CONSTRAINT; Schema: infra; Owner: -
--

ALTER TABLE ONLY infra.images
    ADD CONSTRAINT images_docker_image_key UNIQUE (docker_image);


--
-- Name: images images_name_key; Type: CONSTRAINT; Schema: infra; Owner: -
--

ALTER TABLE ONLY infra.images
    ADD CONSTRAINT images_name_key UNIQUE (name);


--
-- Name: images images_pkey; Type: CONSTRAINT; Schema: infra; Owner: -
--

ALTER TABLE ONLY infra.images
    ADD CONSTRAINT images_pkey PRIMARY KEY (id);


--
-- Name: remote_fs_mounts remote_fs_mounts_host_mount_point_key; Type: CONSTRAINT; Schema: infra; Owner: -
--

ALTER TABLE ONLY infra.remote_fs_mounts
    ADD CONSTRAINT remote_fs_mounts_host_mount_point_key UNIQUE (host_mount_point);


--
-- Name: remote_fs_mounts remote_fs_mounts_pkey; Type: CONSTRAINT; Schema: infra; Owner: -
--

ALTER TABLE ONLY infra.remote_fs_mounts
    ADD CONSTRAINT remote_fs_mounts_pkey PRIMARY KEY (id);


--
-- Name: remote_fs_server_assignments remote_fs_server_assignments_pkey; Type: CONSTRAINT; Schema: infra; Owner: -
--

ALTER TABLE ONLY infra.remote_fs_server_assignments
    ADD CONSTRAINT remote_fs_server_assignments_pkey PRIMARY KEY (id);


--
-- Name: remote_fs_server_assignments remote_fs_server_assignments_remote_fs_mount_id_server_id_key; Type: CONSTRAINT; Schema: infra; Owner: -
--

ALTER TABLE ONLY infra.remote_fs_server_assignments
    ADD CONSTRAINT remote_fs_server_assignments_remote_fs_mount_id_server_id_key UNIQUE (remote_fs_mount_id, server_id);


--
-- Name: servers servers_agent_token_hash_key; Type: CONSTRAINT; Schema: infra; Owner: -
--

ALTER TABLE ONLY infra.servers
    ADD CONSTRAINT servers_agent_token_hash_key UNIQUE (agent_token_hash);


--
-- Name: servers servers_host_fingerprint_key; Type: CONSTRAINT; Schema: infra; Owner: -
--

ALTER TABLE ONLY infra.servers
    ADD CONSTRAINT servers_host_fingerprint_key UNIQUE (host_fingerprint);


--
-- Name: servers servers_pkey; Type: CONSTRAINT; Schema: infra; Owner: -
--

ALTER TABLE ONLY infra.servers
    ADD CONSTRAINT servers_pkey PRIMARY KEY (id);


--
-- Name: servers servers_slug_key; Type: CONSTRAINT; Schema: infra; Owner: -
--

ALTER TABLE ONLY infra.servers
    ADD CONSTRAINT servers_slug_key UNIQUE (slug);


--
-- Name: http_domain_pools http_domain_pools_pkey; Type: CONSTRAINT; Schema: interaction; Owner: -
--

ALTER TABLE ONLY interaction.http_domain_pools
    ADD CONSTRAINT http_domain_pools_pkey PRIMARY KEY (id);


--
-- Name: http_domain_pools http_domain_pools_wildcard_domain_key; Type: CONSTRAINT; Schema: interaction; Owner: -
--

ALTER TABLE ONLY interaction.http_domain_pools
    ADD CONSTRAINT http_domain_pools_wildcard_domain_key UNIQUE (wildcard_domain);


--
-- Name: http_hostname_reservations http_hostname_reservations_pkey; Type: CONSTRAINT; Schema: interaction; Owner: -
--

ALTER TABLE ONLY interaction.http_hostname_reservations
    ADD CONSTRAINT http_hostname_reservations_pkey PRIMARY KEY (hostname);


--
-- Name: http_proxy_bindings http_proxy_bindings_hostname_key; Type: CONSTRAINT; Schema: interaction; Owner: -
--

ALTER TABLE ONLY interaction.http_proxy_bindings
    ADD CONSTRAINT http_proxy_bindings_hostname_key UNIQUE (hostname);


--
-- Name: http_proxy_bindings http_proxy_bindings_pkey; Type: CONSTRAINT; Schema: interaction; Owner: -
--

ALTER TABLE ONLY interaction.http_proxy_bindings
    ADD CONSTRAINT http_proxy_bindings_pkey PRIMARY KEY (id);


--
-- Name: http_proxy_snapshot_state http_proxy_snapshot_state_pkey; Type: CONSTRAINT; Schema: interaction; Owner: -
--

ALTER TABLE ONLY interaction.http_proxy_snapshot_state
    ADD CONSTRAINT http_proxy_snapshot_state_pkey PRIMARY KEY (singleton);


--
-- Name: ssh_proxy_host_keys ssh_proxy_host_keys_pkey; Type: CONSTRAINT; Schema: interaction; Owner: -
--

ALTER TABLE ONLY interaction.ssh_proxy_host_keys
    ADD CONSTRAINT ssh_proxy_host_keys_pkey PRIMARY KEY (id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: system; Owner: -
--

ALTER TABLE ONLY system.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (singleton);


--
-- Name: agent_observations agent_observations_pkey; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.agent_observations
    ADD CONSTRAINT agent_observations_pkey PRIMARY KEY (id);


--
-- Name: agent_observations agent_observations_session_id_sequence_kind_key; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.agent_observations
    ADD CONSTRAINT agent_observations_session_id_sequence_kind_key UNIQUE (session_id, sequence, kind);


--
-- Name: agent_runtime_projections agent_runtime_projections_pkey; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.agent_runtime_projections
    ADD CONSTRAINT agent_runtime_projections_pkey PRIMARY KEY (server_id);


--
-- Name: agent_sessions agent_sessions_pkey; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.agent_sessions
    ADD CONSTRAINT agent_sessions_pkey PRIMARY KEY (id);


--
-- Name: agent_sessions agent_sessions_server_id_generation_key; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.agent_sessions
    ADD CONSTRAINT agent_sessions_server_id_generation_key UNIQUE (server_id, generation);


--
-- Name: agent_sessions agent_sessions_session_token_hash_key; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.agent_sessions
    ADD CONSTRAINT agent_sessions_session_token_hash_key UNIQUE (session_token_hash);


--
-- Name: commands commands_pkey; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.commands
    ADD CONSTRAINT commands_pkey PRIMARY KEY (id);


--
-- Name: exec_sessions exec_sessions_pkey; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.exec_sessions
    ADD CONSTRAINT exec_sessions_pkey PRIMARY KEY (id);


--
-- Name: outbox outbox_pkey; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (id);


--
-- Name: reconcile_queue reconcile_queue_dedupe_key_key; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.reconcile_queue
    ADD CONSTRAINT reconcile_queue_dedupe_key_key UNIQUE (dedupe_key);


--
-- Name: reconcile_queue reconcile_queue_pkey; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.reconcile_queue
    ADD CONSTRAINT reconcile_queue_pkey PRIMARY KEY (id);


--
-- Name: resource_claims resource_claims_pkey; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.resource_claims
    ADD CONSTRAINT resource_claims_pkey PRIMARY KEY (resource_key);


--
-- Name: server_execution_lanes server_execution_lanes_pkey; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.server_execution_lanes
    ADD CONSTRAINT server_execution_lanes_pkey PRIMARY KEY (server_id);


--
-- Name: task_attempts task_attempts_claim_token_key; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.task_attempts
    ADD CONSTRAINT task_attempts_claim_token_key UNIQUE (claim_token);


--
-- Name: task_attempts task_attempts_pkey; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.task_attempts
    ADD CONSTRAINT task_attempts_pkey PRIMARY KEY (id);


--
-- Name: task_attempts task_attempts_task_id_task_generation_attempt_no_key; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.task_attempts
    ADD CONSTRAINT task_attempts_task_id_task_generation_attempt_no_key UNIQUE (task_id, task_generation, attempt_no);


--
-- Name: tasks tasks_command_id_key; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.tasks
    ADD CONSTRAINT tasks_command_id_key UNIQUE (command_id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: agent_sessions workflow_agent_sessions_id_generation_unique; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.agent_sessions
    ADD CONSTRAINT workflow_agent_sessions_id_generation_unique UNIQUE (id, generation);


--
-- Name: audit_events_action_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX audit_events_action_idx ON audit.events USING btree (action, occurred_at DESC, id DESC);


--
-- Name: audit_events_actor_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX audit_events_actor_idx ON audit.events USING btree (actor_id, occurred_at DESC, id DESC) WHERE (actor_id IS NOT NULL);


--
-- Name: audit_events_occurred_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX audit_events_occurred_idx ON audit.events USING btree (occurred_at DESC, id DESC);


--
-- Name: audit_events_target_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX audit_events_target_idx ON audit.events USING btree (target_type, target_id, occurred_at DESC, id DESC) WHERE ((target_type IS NOT NULL) OR (target_id IS NOT NULL));


--
-- Name: audit_events_target_id_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX audit_events_target_id_idx ON audit.events USING btree (target_id, occurred_at DESC, id DESC) WHERE (target_id IS NOT NULL);


--
-- Name: authorization_dependencies_server_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE INDEX authorization_dependencies_server_idx ON control.authorization_dependencies USING btree (user_id, server_id);


--
-- Name: authorization_dependencies_source_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE INDEX authorization_dependencies_source_idx ON control.authorization_dependencies USING btree (user_id, source_kind, source_id, server_id);


--
-- Name: container_gpu_claims_server_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE INDEX container_gpu_claims_server_idx ON control.container_gpu_claims USING btree (server_id, gpu_index, container_id);


--
-- Name: container_mounts_resource_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE INDEX container_mounts_resource_idx ON control.container_mounts USING btree (resource_id);


--
-- Name: container_mounts_source_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE INDEX container_mounts_source_idx ON control.container_mounts USING btree (user_id, server_id, source_kind, source_id, source_identity);


--
-- Name: container_network_claims_container_owner_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE UNIQUE INDEX container_network_claims_container_owner_idx ON control.container_network_claims USING btree (container_id) WHERE ((owner_kind = 'container'::text) AND (container_id IS NOT NULL));


--
-- Name: container_network_claims_owner_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE UNIQUE INDEX container_network_claims_owner_idx ON control.container_network_claims USING btree (owner_kind, owner_id);


--
-- Name: container_network_claims_reusable_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE INDEX container_network_claims_reusable_idx ON control.container_network_claims USING btree (reusable_at, id) WHERE (state = 'releasing'::text);


--
-- Name: container_network_claims_server_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE INDEX container_network_claims_server_idx ON control.container_network_claims USING btree (server_id, state);


--
-- Name: container_ssh_routes_ip_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE INDEX container_ssh_routes_ip_idx ON control.container_ssh_routes USING btree (macvlan_ip) WHERE (macvlan_ip IS NOT NULL);


--
-- Name: containers_active_task_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE INDEX containers_active_task_idx ON control.containers USING btree (active_task_id) WHERE (active_task_id IS NOT NULL);


--
-- Name: containers_image_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE INDEX containers_image_idx ON control.containers USING btree (image_id);


--
-- Name: containers_owner_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE INDEX containers_owner_idx ON control.containers USING btree (owner_id, created_at DESC, id);


--
-- Name: containers_server_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE INDEX containers_server_idx ON control.containers USING btree (server_id, created_at DESC, id);


--
-- Name: data_directories_local_physical_unique; Type: INDEX; Schema: control; Owner: -
--

CREATE UNIQUE INDEX data_directories_local_physical_unique ON control.data_directories USING btree (server_id, source_id, name) WHERE (source_kind = 'local'::text);


--
-- Name: data_directories_remote_physical_unique; Type: INDEX; Schema: control; Owner: -
--

CREATE UNIQUE INDEX data_directories_remote_physical_unique ON control.data_directories USING btree (source_id, name) WHERE (source_kind = 'remote'::text);


--
-- Name: data_directories_source_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE INDEX data_directories_source_idx ON control.data_directories USING btree (source_kind, source_id, desired_state);


--
-- Name: data_directories_task_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE INDEX data_directories_task_idx ON control.data_directories USING btree (last_task_id) WHERE (last_task_id IS NOT NULL);


--
-- Name: data_directories_user_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE INDEX data_directories_user_idx ON control.data_directories USING btree (user_id, desired_state);


--
-- Name: quota_desired_task_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE INDEX quota_desired_task_idx ON control.quota_desired USING btree (last_task_id) WHERE (last_task_id IS NOT NULL);


--
-- Name: quota_desired_user_idx; Type: INDEX; Schema: control; Owner: -
--

CREATE INDEX quota_desired_user_idx ON control.quota_desired USING btree (user_id, server_id);


--
-- Name: api_tokens_user_created_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX api_tokens_user_created_idx ON iam.api_tokens USING btree (user_id, created_at DESC, id);


--
-- Name: group_members_user_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX group_members_user_idx ON iam.group_members USING btree (user_id, group_id);


--
-- Name: groups_priority_name_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX groups_priority_name_idx ON iam.groups USING btree (priority DESC, name);


--
-- Name: image_grants_group_unique; Type: INDEX; Schema: iam; Owner: -
--

CREATE UNIQUE INDEX image_grants_group_unique ON iam.image_grants USING btree (group_id, image_id, server_id) WHERE (group_id IS NOT NULL);


--
-- Name: image_grants_server_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX image_grants_server_idx ON iam.image_grants USING btree (server_id, image_id);


--
-- Name: image_grants_user_unique; Type: INDEX; Schema: iam; Owner: -
--

CREATE UNIQUE INDEX image_grants_user_unique ON iam.image_grants USING btree (user_id, image_id, server_id) WHERE (user_id IS NOT NULL);


--
-- Name: mount_source_grants_group_local_unique; Type: INDEX; Schema: iam; Owner: -
--

CREATE UNIQUE INDEX mount_source_grants_group_local_unique ON iam.mount_source_grants USING btree (group_id, source_id, server_id, source_identity) WHERE ((group_id IS NOT NULL) AND (source_kind = 'local'::text));


--
-- Name: mount_source_grants_group_remote_unique; Type: INDEX; Schema: iam; Owner: -
--

CREATE UNIQUE INDEX mount_source_grants_group_remote_unique ON iam.mount_source_grants USING btree (group_id, source_id) WHERE ((group_id IS NOT NULL) AND (source_kind = 'remote'::text));


--
-- Name: mount_source_grants_source_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX mount_source_grants_source_idx ON iam.mount_source_grants USING btree (source_kind, source_id);


--
-- Name: mount_source_grants_user_local_unique; Type: INDEX; Schema: iam; Owner: -
--

CREATE UNIQUE INDEX mount_source_grants_user_local_unique ON iam.mount_source_grants USING btree (user_id, source_id, server_id, source_identity) WHERE ((user_id IS NOT NULL) AND (source_kind = 'local'::text));


--
-- Name: mount_source_grants_user_remote_unique; Type: INDEX; Schema: iam; Owner: -
--

CREATE UNIQUE INDEX mount_source_grants_user_remote_unique ON iam.mount_source_grants USING btree (user_id, source_id) WHERE ((user_id IS NOT NULL) AND (source_kind = 'remote'::text));


--
-- Name: refresh_tokens_expiry_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX refresh_tokens_expiry_idx ON iam.refresh_tokens USING btree (expires_at);


--
-- Name: refresh_tokens_previous_hash_unique; Type: INDEX; Schema: iam; Owner: -
--

CREATE UNIQUE INDEX refresh_tokens_previous_hash_unique ON iam.refresh_tokens USING btree (previous_hash) WHERE (previous_hash IS NOT NULL);


--
-- Name: refresh_tokens_revoked_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX refresh_tokens_revoked_idx ON iam.refresh_tokens USING btree (id) WHERE revoked;


--
-- Name: refresh_tokens_user_active_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX refresh_tokens_user_active_idx ON iam.refresh_tokens USING btree (user_id, created_at, id) WHERE (NOT revoked);


--
-- Name: server_grants_group_unique; Type: INDEX; Schema: iam; Owner: -
--

CREATE UNIQUE INDEX server_grants_group_unique ON iam.server_grants USING btree (group_id, server_id) WHERE (group_id IS NOT NULL);


--
-- Name: server_grants_server_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX server_grants_server_idx ON iam.server_grants USING btree (server_id);


--
-- Name: server_grants_user_unique; Type: INDEX; Schema: iam; Owner: -
--

CREATE UNIQUE INDEX server_grants_user_unique ON iam.server_grants USING btree (user_id, server_id) WHERE (user_id IS NOT NULL);


--
-- Name: ssh_public_keys_user_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX ssh_public_keys_user_idx ON iam.ssh_public_keys USING btree (user_id, created_at, id);


--
-- Name: user_internal_ssh_keys_fingerprint_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX user_internal_ssh_keys_fingerprint_idx ON iam.user_internal_ssh_keys USING btree (fingerprint);


--
-- Name: users_status_idx; Type: INDEX; Schema: iam; Owner: -
--

CREATE INDEX users_status_idx ON iam.users USING btree (status, username);


--
-- Name: images_catalog_idx; Type: INDEX; Schema: infra; Owner: -
--

CREATE INDEX images_catalog_idx ON infra.images USING btree (is_active, deleting, name, id);


--
-- Name: remote_fs_assignments_mount_idx; Type: INDEX; Schema: infra; Owner: -
--

CREATE INDEX remote_fs_assignments_mount_idx ON infra.remote_fs_server_assignments USING btree (remote_fs_mount_id, desired_state);


--
-- Name: remote_fs_assignments_server_idx; Type: INDEX; Schema: infra; Owner: -
--

CREATE INDEX remote_fs_assignments_server_idx ON infra.remote_fs_server_assignments USING btree (server_id, desired_state);


--
-- Name: remote_fs_mounts_desired_state_idx; Type: INDEX; Schema: infra; Owner: -
--

CREATE INDEX remote_fs_mounts_desired_state_idx ON infra.remote_fs_mounts USING btree (desired_state, id);


--
-- Name: remote_fs_mounts_name_idx; Type: INDEX; Schema: infra; Owner: -
--

CREATE INDEX remote_fs_mounts_name_idx ON infra.remote_fs_mounts USING btree (name, id);


--
-- Name: servers_name_idx; Type: INDEX; Schema: infra; Owner: -
--

CREATE INDEX servers_name_idx ON infra.servers USING btree (name, id);


--
-- Name: servers_quarantine_idx; Type: INDEX; Schema: infra; Owner: -
--

CREATE INDEX servers_quarantine_idx ON infra.servers USING btree (quarantine_code) WHERE (quarantine_code IS NOT NULL);


--
-- Name: servers_status_idx; Type: INDEX; Schema: infra; Owner: -
--

CREATE INDEX servers_status_idx ON infra.servers USING btree (status);


--
-- Name: http_hostname_active_binding_idx; Type: INDEX; Schema: interaction; Owner: -
--

CREATE UNIQUE INDEX http_hostname_active_binding_idx ON interaction.http_hostname_reservations USING btree (binding_id) WHERE (state = 'active'::text);


--
-- Name: http_hostname_reusable_idx; Type: INDEX; Schema: interaction; Owner: -
--

CREATE INDEX http_hostname_reusable_idx ON interaction.http_hostname_reservations USING btree (reusable_at, hostname) WHERE (state = 'releasing'::text);


--
-- Name: http_proxy_bindings_container_idx; Type: INDEX; Schema: interaction; Owner: -
--

CREATE INDEX http_proxy_bindings_container_idx ON interaction.http_proxy_bindings USING btree (container_id, id);


--
-- Name: http_proxy_bindings_owner_idx; Type: INDEX; Schema: interaction; Owner: -
--

CREATE INDEX http_proxy_bindings_owner_idx ON interaction.http_proxy_bindings USING btree (owner_id, hostname, id);


--
-- Name: http_proxy_bindings_pool_idx; Type: INDEX; Schema: interaction; Owner: -
--

CREATE INDEX http_proxy_bindings_pool_idx ON interaction.http_proxy_bindings USING btree (domain_pool_id, id);


--
-- Name: workflow_agent_observations_server_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX workflow_agent_observations_server_idx ON workflow.agent_observations USING btree (server_id, observed_at DESC, id DESC);


--
-- Name: workflow_agent_runtime_projections_owner_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX workflow_agent_runtime_projections_owner_idx ON workflow.agent_runtime_projections USING btree (gateway_id, updated_at DESC);


--
-- Name: workflow_agent_sessions_gateway_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX workflow_agent_sessions_gateway_idx ON workflow.agent_sessions USING btree (gateway_id, state, lease_expires_at);


--
-- Name: workflow_agent_sessions_one_current; Type: INDEX; Schema: workflow; Owner: -
--

CREATE UNIQUE INDEX workflow_agent_sessions_one_current ON workflow.agent_sessions USING btree (server_id) WHERE (state = ANY (ARRAY['admitted'::text, 'ready'::text]));


--
-- Name: workflow_exec_sessions_active_server_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX workflow_exec_sessions_active_server_idx ON workflow.exec_sessions USING btree (server_id, expires_at) WHERE (state = ANY (ARRAY['unclaimed'::text, 'claimed'::text]));


--
-- Name: workflow_exec_sessions_active_user_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX workflow_exec_sessions_active_user_idx ON workflow.exec_sessions USING btree (user_id, expires_at) WHERE (state = ANY (ARRAY['unclaimed'::text, 'claimed'::text]));


--
-- Name: workflow_outbox_due_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX workflow_outbox_due_idx ON workflow.outbox USING btree (available_at, id);


--
-- Name: workflow_reconcile_due_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX workflow_reconcile_due_idx ON workflow.reconcile_queue USING btree (due_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


--
-- Name: workflow_resource_claims_server_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX workflow_resource_claims_server_idx ON workflow.resource_claims USING btree (server_id, resource_key);


--
-- Name: workflow_resource_claims_task_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX workflow_resource_claims_task_idx ON workflow.resource_claims USING btree (task_id, task_generation);


--
-- Name: workflow_task_attempts_session_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX workflow_task_attempts_session_idx ON workflow.task_attempts USING btree (agent_session_id, agent_session_generation, state, attempt_no DESC);


--
-- Name: workflow_task_attempts_task_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX workflow_task_attempts_task_idx ON workflow.task_attempts USING btree (task_id, attempt_no DESC);


--
-- Name: workflow_tasks_dispatch_due_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX workflow_tasks_dispatch_due_idx ON workflow.tasks USING btree (server_id, admission_class, next_dispatch_at, created_at, id) WHERE ((status = 'pending'::text) AND (agent_result_json IS NULL));


--
-- Name: workflow_tasks_finalizer_due_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX workflow_tasks_finalizer_due_idx ON workflow.tasks USING btree (finalizer_retry_at, result_received_at, id) WHERE ((status = 'pending'::text) AND (agent_result_json IS NOT NULL));


--
-- Name: workflow_tasks_one_physical_owner_per_server; Type: INDEX; Schema: workflow; Owner: -
--

CREATE UNIQUE INDEX workflow_tasks_one_physical_owner_per_server ON workflow.tasks USING btree (server_id) WHERE ((status = 'pending'::text) AND (agent_result_json IS NULL) AND (dispatch_claim_token IS NOT NULL));


--
-- Name: workflow_tasks_resource_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX workflow_tasks_resource_idx ON workflow.tasks USING btree (resource_type, resource_id, status, created_at DESC);


--
-- Name: workflow_tasks_retention_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX workflow_tasks_retention_idx ON workflow.tasks USING btree (completed_at, id) WHERE (completed_at IS NOT NULL);


--
-- Name: events audit_events_reject_update; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER audit_events_reject_update BEFORE UPDATE ON audit.events FOR EACH ROW EXECUTE FUNCTION audit.reject_event_update();


--
-- Name: container_mounts container_mounts_authorization_dependency; Type: TRIGGER; Schema: control; Owner: -
--

CREATE TRIGGER container_mounts_authorization_dependency AFTER INSERT OR DELETE OR UPDATE OF user_id, server_id, source_kind, source_id, source_identity ON control.container_mounts FOR EACH ROW EXECUTE FUNCTION control.sync_container_mount_authorization_dependency();


--
-- Name: container_mounts container_mounts_touch_updated_at; Type: TRIGGER; Schema: control; Owner: -
--

CREATE TRIGGER container_mounts_touch_updated_at BEFORE UPDATE ON control.container_mounts FOR EACH ROW EXECUTE FUNCTION control.touch_container_updated_at();


--
-- Name: container_network_claims container_network_claims_touch_updated_at; Type: TRIGGER; Schema: control; Owner: -
--

CREATE TRIGGER container_network_claims_touch_updated_at BEFORE UPDATE ON control.container_network_claims FOR EACH ROW EXECUTE FUNCTION control.touch_container_updated_at();


--
-- Name: containers containers_authorization_dependency; Type: TRIGGER; Schema: control; Owner: -
--

CREATE TRIGGER containers_authorization_dependency AFTER INSERT OR DELETE OR UPDATE OF owner_id, server_id ON control.containers FOR EACH ROW EXECUTE FUNCTION control.sync_container_authorization_dependency();


--
-- Name: containers containers_identity_immutable; Type: TRIGGER; Schema: control; Owner: -
--

CREATE TRIGGER containers_identity_immutable BEFORE UPDATE OF server_id, owner_id, image_id, created_by ON control.containers FOR EACH ROW EXECUTE FUNCTION control.reject_container_identity_change();


--
-- Name: containers containers_touch_updated_at; Type: TRIGGER; Schema: control; Owner: -
--

CREATE TRIGGER containers_touch_updated_at BEFORE UPDATE ON control.containers FOR EACH ROW EXECUTE FUNCTION control.touch_container_updated_at();


--
-- Name: data_directories data_directories_remote_source_check; Type: TRIGGER; Schema: control; Owner: -
--

CREATE TRIGGER data_directories_remote_source_check BEFORE INSERT OR UPDATE OF source_kind, source_id ON control.data_directories FOR EACH ROW EXECUTE FUNCTION control.require_remote_storage_source();


--
-- Name: data_directories data_directories_touch_updated_at; Type: TRIGGER; Schema: control; Owner: -
--

CREATE TRIGGER data_directories_touch_updated_at BEFORE UPDATE ON control.data_directories FOR EACH ROW EXECUTE FUNCTION control.touch_storage_updated_at();


--
-- Name: quota_desired quota_desired_touch_updated_at; Type: TRIGGER; Schema: control; Owner: -
--

CREATE TRIGGER quota_desired_touch_updated_at BEFORE UPDATE ON control.quota_desired FOR EACH ROW EXECUTE FUNCTION control.touch_storage_updated_at();


--
-- Name: group_members group_members_authorization_barrier; Type: TRIGGER; Schema: iam; Owner: -
--

CREATE TRIGGER group_members_authorization_barrier BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON iam.group_members FOR EACH STATEMENT EXECUTE FUNCTION iam.lock_policy_state_before_mutation();


--
-- Name: group_members group_members_authorization_touch; Type: TRIGGER; Schema: iam; Owner: -
--

CREATE TRIGGER group_members_authorization_touch AFTER INSERT OR DELETE ON iam.group_members FOR EACH ROW EXECUTE FUNCTION iam.touch_membership_authorization();


--
-- Name: groups groups_authorization_barrier; Type: TRIGGER; Schema: iam; Owner: -
--

CREATE TRIGGER groups_authorization_barrier BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON iam.groups FOR EACH STATEMENT EXECUTE FUNCTION iam.lock_policy_state_before_mutation();


--
-- Name: groups groups_authorization_touch; Type: TRIGGER; Schema: iam; Owner: -
--

CREATE TRIGGER groups_authorization_touch AFTER UPDATE OF capabilities, priority ON iam.groups FOR EACH ROW EXECUTE FUNCTION iam.touch_group_authorization();


--
-- Name: image_grants image_grants_authorization_barrier; Type: TRIGGER; Schema: iam; Owner: -
--

CREATE TRIGGER image_grants_authorization_barrier BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON iam.image_grants FOR EACH STATEMENT EXECUTE FUNCTION iam.lock_policy_state_before_mutation();


--
-- Name: image_grants image_grants_authorization_touch; Type: TRIGGER; Schema: iam; Owner: -
--

CREATE TRIGGER image_grants_authorization_touch AFTER INSERT OR DELETE OR UPDATE ON iam.image_grants FOR EACH ROW EXECUTE FUNCTION iam.touch_authorization_subjects();


--
-- Name: mount_source_grants mount_source_grants_authorization_barrier; Type: TRIGGER; Schema: iam; Owner: -
--

CREATE TRIGGER mount_source_grants_authorization_barrier BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON iam.mount_source_grants FOR EACH STATEMENT EXECUTE FUNCTION iam.lock_policy_state_before_mutation();


--
-- Name: mount_source_grants mount_source_grants_authorization_touch; Type: TRIGGER; Schema: iam; Owner: -
--

CREATE TRIGGER mount_source_grants_authorization_touch AFTER INSERT OR DELETE OR UPDATE ON iam.mount_source_grants FOR EACH ROW EXECUTE FUNCTION iam.touch_authorization_subjects();


--
-- Name: mount_source_grants mount_source_grants_remote_source_check; Type: TRIGGER; Schema: iam; Owner: -
--

CREATE TRIGGER mount_source_grants_remote_source_check BEFORE INSERT OR UPDATE OF source_kind, source_id ON iam.mount_source_grants FOR EACH ROW EXECUTE FUNCTION iam.require_remote_mount_source();


--
-- Name: server_grants server_grants_authorization_barrier; Type: TRIGGER; Schema: iam; Owner: -
--

CREATE TRIGGER server_grants_authorization_barrier BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON iam.server_grants FOR EACH STATEMENT EXECUTE FUNCTION iam.lock_policy_state_before_mutation();


--
-- Name: server_grants server_grants_authorization_touch; Type: TRIGGER; Schema: iam; Owner: -
--

CREATE TRIGGER server_grants_authorization_touch AFTER INSERT OR DELETE OR UPDATE ON iam.server_grants FOR EACH ROW EXECUTE FUNCTION iam.touch_authorization_subjects();


--
-- Name: users users_authorization_barrier; Type: TRIGGER; Schema: iam; Owner: -
--

CREATE TRIGGER users_authorization_barrier BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON iam.users FOR EACH STATEMENT EXECUTE FUNCTION iam.lock_policy_state_before_mutation();


--
-- Name: images images_docker_image_immutable; Type: TRIGGER; Schema: infra; Owner: -
--

CREATE TRIGGER images_docker_image_immutable BEFORE UPDATE OF docker_image ON infra.images FOR EACH ROW EXECUTE FUNCTION infra.reject_image_reference_change();


--
-- Name: images images_touch_updated_at; Type: TRIGGER; Schema: infra; Owner: -
--

CREATE TRIGGER images_touch_updated_at BEFORE UPDATE ON infra.images FOR EACH ROW EXECUTE FUNCTION infra.touch_updated_at();


--
-- Name: remote_fs_server_assignments remote_fs_assignments_touch_updated_at; Type: TRIGGER; Schema: infra; Owner: -
--

CREATE TRIGGER remote_fs_assignments_touch_updated_at BEFORE UPDATE ON infra.remote_fs_server_assignments FOR EACH ROW EXECUTE FUNCTION infra.touch_storage_updated_at();


--
-- Name: remote_fs_mounts remote_fs_mounts_touch_updated_at; Type: TRIGGER; Schema: infra; Owner: -
--

CREATE TRIGGER remote_fs_mounts_touch_updated_at BEFORE UPDATE ON infra.remote_fs_mounts FOR EACH ROW EXECUTE FUNCTION infra.touch_storage_updated_at();


--
-- Name: servers servers_touch_updated_at; Type: TRIGGER; Schema: infra; Owner: -
--

CREATE TRIGGER servers_touch_updated_at BEFORE UPDATE ON infra.servers FOR EACH ROW EXECUTE FUNCTION infra.touch_updated_at();


--
-- Name: http_domain_pools http_domain_pools_touch_updated_at; Type: TRIGGER; Schema: interaction; Owner: -
--

CREATE TRIGGER http_domain_pools_touch_updated_at BEFORE UPDATE ON interaction.http_domain_pools FOR EACH ROW EXECUTE FUNCTION interaction.touch_http_proxy_updated_at();


--
-- Name: http_hostname_reservations http_hostname_reservations_touch_updated_at; Type: TRIGGER; Schema: interaction; Owner: -
--

CREATE TRIGGER http_hostname_reservations_touch_updated_at BEFORE UPDATE ON interaction.http_hostname_reservations FOR EACH ROW EXECUTE FUNCTION interaction.touch_http_hostname_updated_at();


--
-- Name: http_proxy_bindings http_proxy_bindings_drain_hostname; Type: TRIGGER; Schema: interaction; Owner: -
--

CREATE TRIGGER http_proxy_bindings_drain_hostname BEFORE DELETE ON interaction.http_proxy_bindings FOR EACH ROW EXECUTE FUNCTION interaction.drain_http_binding_hostname();


--
-- Name: http_proxy_bindings http_proxy_bindings_touch_updated_at; Type: TRIGGER; Schema: interaction; Owner: -
--

CREATE TRIGGER http_proxy_bindings_touch_updated_at BEFORE UPDATE ON interaction.http_proxy_bindings FOR EACH ROW EXECUTE FUNCTION interaction.touch_http_proxy_updated_at();


--
-- Name: agent_runtime_projections workflow_agent_runtime_projections_touch_updated_at; Type: TRIGGER; Schema: workflow; Owner: -
--

CREATE TRIGGER workflow_agent_runtime_projections_touch_updated_at BEFORE UPDATE ON workflow.agent_runtime_projections FOR EACH ROW EXECUTE FUNCTION workflow.touch_updated_at();


--
-- Name: reconcile_queue workflow_reconcile_touch_updated_at; Type: TRIGGER; Schema: workflow; Owner: -
--

CREATE TRIGGER workflow_reconcile_touch_updated_at BEFORE UPDATE ON workflow.reconcile_queue FOR EACH ROW EXECUTE FUNCTION workflow.touch_updated_at();


--
-- Name: resource_claims workflow_resource_claims_touch_updated_at; Type: TRIGGER; Schema: workflow; Owner: -
--

CREATE TRIGGER workflow_resource_claims_touch_updated_at BEFORE UPDATE ON workflow.resource_claims FOR EACH ROW EXECUTE FUNCTION workflow.touch_updated_at();


--
-- Name: server_execution_lanes workflow_server_lanes_touch_updated_at; Type: TRIGGER; Schema: workflow; Owner: -
--

CREATE TRIGGER workflow_server_lanes_touch_updated_at BEFORE UPDATE ON workflow.server_execution_lanes FOR EACH ROW EXECUTE FUNCTION workflow.touch_updated_at();


--
-- Name: tasks workflow_tasks_touch_updated_at; Type: TRIGGER; Schema: workflow; Owner: -
--

CREATE TRIGGER workflow_tasks_touch_updated_at BEFORE UPDATE ON workflow.tasks FOR EACH ROW EXECUTE FUNCTION workflow.touch_updated_at();


--
-- Name: authorization_dependencies authorization_dependencies_user_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.authorization_dependencies
    ADD CONSTRAINT authorization_dependencies_user_id_fkey FOREIGN KEY (user_id) REFERENCES iam.users(id) ON DELETE RESTRICT;


--
-- Name: container_gpu_claims container_gpu_claims_container_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_gpu_claims
    ADD CONSTRAINT container_gpu_claims_container_id_fkey FOREIGN KEY (container_id) REFERENCES control.containers(id) ON DELETE CASCADE;


--
-- Name: container_gpu_claims container_gpu_claims_server_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_gpu_claims
    ADD CONSTRAINT container_gpu_claims_server_id_fkey FOREIGN KEY (server_id) REFERENCES infra.servers(id) ON DELETE RESTRICT;


--
-- Name: container_mounts container_mounts_container_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_mounts
    ADD CONSTRAINT container_mounts_container_id_fkey FOREIGN KEY (container_id) REFERENCES control.containers(id) ON DELETE CASCADE;


--
-- Name: container_mounts container_mounts_resource_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_mounts
    ADD CONSTRAINT container_mounts_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES control.data_directories(id) ON DELETE RESTRICT;


--
-- Name: container_mounts container_mounts_server_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_mounts
    ADD CONSTRAINT container_mounts_server_id_fkey FOREIGN KEY (server_id) REFERENCES infra.servers(id) ON DELETE RESTRICT;


--
-- Name: container_mounts container_mounts_user_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_mounts
    ADD CONSTRAINT container_mounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES iam.users(id) ON DELETE RESTRICT;


--
-- Name: container_network_claims container_network_claims_container_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_network_claims
    ADD CONSTRAINT container_network_claims_container_id_fkey FOREIGN KEY (container_id) REFERENCES control.containers(id) ON DELETE SET NULL;


--
-- Name: container_network_claims container_network_claims_server_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_network_claims
    ADD CONSTRAINT container_network_claims_server_id_fkey FOREIGN KEY (server_id) REFERENCES infra.servers(id) ON DELETE RESTRICT;


--
-- Name: container_ssh_routes container_ssh_routes_container_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_ssh_routes
    ADD CONSTRAINT container_ssh_routes_container_id_fkey FOREIGN KEY (container_id) REFERENCES control.containers(id) ON DELETE CASCADE;


--
-- Name: container_ssh_routes container_ssh_routes_server_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.container_ssh_routes
    ADD CONSTRAINT container_ssh_routes_server_id_fkey FOREIGN KEY (server_id) REFERENCES infra.servers(id) ON DELETE RESTRICT;


--
-- Name: containers containers_active_task_fk; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.containers
    ADD CONSTRAINT containers_active_task_fk FOREIGN KEY (active_task_id) REFERENCES workflow.tasks(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;


--
-- Name: containers containers_created_by_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.containers
    ADD CONSTRAINT containers_created_by_fkey FOREIGN KEY (created_by) REFERENCES iam.users(id) ON DELETE RESTRICT;


--
-- Name: containers containers_image_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.containers
    ADD CONSTRAINT containers_image_id_fkey FOREIGN KEY (image_id) REFERENCES infra.images(id) ON DELETE RESTRICT;


--
-- Name: containers containers_owner_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.containers
    ADD CONSTRAINT containers_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES iam.users(id) ON DELETE RESTRICT;


--
-- Name: containers containers_server_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.containers
    ADD CONSTRAINT containers_server_id_fkey FOREIGN KEY (server_id) REFERENCES infra.servers(id) ON DELETE RESTRICT;


--
-- Name: data_directories data_directories_last_task_fk; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.data_directories
    ADD CONSTRAINT data_directories_last_task_fk FOREIGN KEY (last_task_id) REFERENCES workflow.tasks(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;


--
-- Name: data_directories data_directories_remote_fs_mount_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.data_directories
    ADD CONSTRAINT data_directories_remote_fs_mount_id_fkey FOREIGN KEY (remote_fs_mount_id) REFERENCES infra.remote_fs_mounts(id) ON DELETE RESTRICT;


--
-- Name: data_directories data_directories_server_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.data_directories
    ADD CONSTRAINT data_directories_server_id_fkey FOREIGN KEY (server_id) REFERENCES infra.servers(id) ON DELETE RESTRICT;


--
-- Name: data_directories data_directories_user_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.data_directories
    ADD CONSTRAINT data_directories_user_id_fkey FOREIGN KEY (user_id) REFERENCES iam.users(id) ON DELETE RESTRICT;


--
-- Name: quota_desired quota_desired_last_task_fk; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.quota_desired
    ADD CONSTRAINT quota_desired_last_task_fk FOREIGN KEY (last_task_id) REFERENCES workflow.tasks(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;


--
-- Name: quota_desired quota_desired_server_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.quota_desired
    ADD CONSTRAINT quota_desired_server_id_fkey FOREIGN KEY (server_id) REFERENCES infra.servers(id) ON DELETE RESTRICT;


--
-- Name: quota_desired quota_desired_user_id_fkey; Type: FK CONSTRAINT; Schema: control; Owner: -
--

ALTER TABLE ONLY control.quota_desired
    ADD CONSTRAINT quota_desired_user_id_fkey FOREIGN KEY (user_id) REFERENCES iam.users(id) ON DELETE RESTRICT;


--
-- Name: api_tokens api_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.api_tokens
    ADD CONSTRAINT api_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES iam.users(id) ON DELETE CASCADE;


--
-- Name: group_members group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.group_members
    ADD CONSTRAINT group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES iam.groups(id) ON DELETE CASCADE;


--
-- Name: group_members group_members_user_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.group_members
    ADD CONSTRAINT group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES iam.users(id) ON DELETE CASCADE;


--
-- Name: image_grants image_grants_group_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.image_grants
    ADD CONSTRAINT image_grants_group_id_fkey FOREIGN KEY (group_id) REFERENCES iam.groups(id) ON DELETE CASCADE;


--
-- Name: image_grants image_grants_user_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.image_grants
    ADD CONSTRAINT image_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES iam.users(id) ON DELETE CASCADE;


--
-- Name: mount_source_grants mount_source_grants_group_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.mount_source_grants
    ADD CONSTRAINT mount_source_grants_group_id_fkey FOREIGN KEY (group_id) REFERENCES iam.groups(id) ON DELETE CASCADE;


--
-- Name: mount_source_grants mount_source_grants_remote_source_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.mount_source_grants
    ADD CONSTRAINT mount_source_grants_remote_source_fkey FOREIGN KEY (remote_fs_mount_id) REFERENCES infra.remote_fs_mounts(id) ON DELETE RESTRICT;


--
-- Name: mount_source_grants mount_source_grants_user_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.mount_source_grants
    ADD CONSTRAINT mount_source_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES iam.users(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES iam.users(id) ON DELETE CASCADE;


--
-- Name: server_grants server_grants_group_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.server_grants
    ADD CONSTRAINT server_grants_group_id_fkey FOREIGN KEY (group_id) REFERENCES iam.groups(id) ON DELETE CASCADE;


--
-- Name: server_grants server_grants_user_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.server_grants
    ADD CONSTRAINT server_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES iam.users(id) ON DELETE CASCADE;


--
-- Name: ssh_public_keys ssh_public_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.ssh_public_keys
    ADD CONSTRAINT ssh_public_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES iam.users(id) ON DELETE CASCADE;


--
-- Name: user_internal_ssh_keys user_internal_ssh_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: iam; Owner: -
--

ALTER TABLE ONLY iam.user_internal_ssh_keys
    ADD CONSTRAINT user_internal_ssh_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES iam.users(id) ON DELETE CASCADE;


--
-- Name: remote_fs_server_assignments remote_fs_assignments_last_task_fk; Type: FK CONSTRAINT; Schema: infra; Owner: -
--

ALTER TABLE ONLY infra.remote_fs_server_assignments
    ADD CONSTRAINT remote_fs_assignments_last_task_fk FOREIGN KEY (last_task_id) REFERENCES workflow.tasks(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;


--
-- Name: remote_fs_mounts remote_fs_mounts_last_task_fk; Type: FK CONSTRAINT; Schema: infra; Owner: -
--

ALTER TABLE ONLY infra.remote_fs_mounts
    ADD CONSTRAINT remote_fs_mounts_last_task_fk FOREIGN KEY (last_task_id) REFERENCES workflow.tasks(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;


--
-- Name: remote_fs_server_assignments remote_fs_server_assignments_remote_fs_mount_id_fkey; Type: FK CONSTRAINT; Schema: infra; Owner: -
--

ALTER TABLE ONLY infra.remote_fs_server_assignments
    ADD CONSTRAINT remote_fs_server_assignments_remote_fs_mount_id_fkey FOREIGN KEY (remote_fs_mount_id) REFERENCES infra.remote_fs_mounts(id) ON DELETE RESTRICT;


--
-- Name: remote_fs_server_assignments remote_fs_server_assignments_server_id_fkey; Type: FK CONSTRAINT; Schema: infra; Owner: -
--

ALTER TABLE ONLY infra.remote_fs_server_assignments
    ADD CONSTRAINT remote_fs_server_assignments_server_id_fkey FOREIGN KEY (server_id) REFERENCES infra.servers(id) ON DELETE RESTRICT;


--
-- Name: http_hostname_reservations http_hostname_reservations_owner_id_fkey; Type: FK CONSTRAINT; Schema: interaction; Owner: -
--

ALTER TABLE ONLY interaction.http_hostname_reservations
    ADD CONSTRAINT http_hostname_reservations_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES iam.users(id) ON DELETE RESTRICT;


--
-- Name: http_proxy_bindings http_proxy_bindings_container_id_fkey; Type: FK CONSTRAINT; Schema: interaction; Owner: -
--

ALTER TABLE ONLY interaction.http_proxy_bindings
    ADD CONSTRAINT http_proxy_bindings_container_id_fkey FOREIGN KEY (container_id) REFERENCES control.containers(id) ON DELETE CASCADE;


--
-- Name: http_proxy_bindings http_proxy_bindings_domain_pool_id_fkey; Type: FK CONSTRAINT; Schema: interaction; Owner: -
--

ALTER TABLE ONLY interaction.http_proxy_bindings
    ADD CONSTRAINT http_proxy_bindings_domain_pool_id_fkey FOREIGN KEY (domain_pool_id) REFERENCES interaction.http_domain_pools(id) ON DELETE RESTRICT;


--
-- Name: http_proxy_bindings http_proxy_bindings_owner_id_fkey; Type: FK CONSTRAINT; Schema: interaction; Owner: -
--

ALTER TABLE ONLY interaction.http_proxy_bindings
    ADD CONSTRAINT http_proxy_bindings_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES iam.users(id) ON DELETE RESTRICT;


--
-- Name: settings settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: system; Owner: -
--

ALTER TABLE ONLY system.settings
    ADD CONSTRAINT settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES iam.users(id) ON DELETE SET NULL;


--
-- Name: agent_observations agent_observations_server_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.agent_observations
    ADD CONSTRAINT agent_observations_server_id_fkey FOREIGN KEY (server_id) REFERENCES infra.servers(id) ON DELETE CASCADE;


--
-- Name: agent_observations agent_observations_session_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.agent_observations
    ADD CONSTRAINT agent_observations_session_id_fkey FOREIGN KEY (session_id) REFERENCES workflow.agent_sessions(id) ON DELETE CASCADE;


--
-- Name: agent_runtime_projections agent_runtime_projections_server_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.agent_runtime_projections
    ADD CONSTRAINT agent_runtime_projections_server_id_fkey FOREIGN KEY (server_id) REFERENCES infra.servers(id) ON DELETE CASCADE;


--
-- Name: agent_runtime_projections agent_runtime_projections_session_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.agent_runtime_projections
    ADD CONSTRAINT agent_runtime_projections_session_id_fkey FOREIGN KEY (session_id) REFERENCES workflow.agent_sessions(id) ON DELETE CASCADE;


--
-- Name: agent_sessions agent_sessions_server_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.agent_sessions
    ADD CONSTRAINT agent_sessions_server_id_fkey FOREIGN KEY (server_id) REFERENCES infra.servers(id) ON DELETE CASCADE;


--
-- Name: commands commands_requested_by_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.commands
    ADD CONSTRAINT commands_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES iam.users(id) ON DELETE SET NULL;


--
-- Name: commands commands_server_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.commands
    ADD CONSTRAINT commands_server_id_fkey FOREIGN KEY (server_id) REFERENCES infra.servers(id) ON DELETE RESTRICT;


--
-- Name: exec_sessions exec_sessions_agent_session_id_agent_session_generation_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.exec_sessions
    ADD CONSTRAINT exec_sessions_agent_session_id_agent_session_generation_fkey FOREIGN KEY (agent_session_id, agent_session_generation) REFERENCES workflow.agent_sessions(id, generation) ON DELETE RESTRICT;


--
-- Name: exec_sessions exec_sessions_container_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.exec_sessions
    ADD CONSTRAINT exec_sessions_container_id_fkey FOREIGN KEY (container_id) REFERENCES control.containers(id) ON DELETE CASCADE;


--
-- Name: exec_sessions exec_sessions_server_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.exec_sessions
    ADD CONSTRAINT exec_sessions_server_id_fkey FOREIGN KEY (server_id) REFERENCES infra.servers(id) ON DELETE CASCADE;


--
-- Name: exec_sessions exec_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.exec_sessions
    ADD CONSTRAINT exec_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES iam.users(id) ON DELETE CASCADE;


--
-- Name: reconcile_queue reconcile_queue_server_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.reconcile_queue
    ADD CONSTRAINT reconcile_queue_server_id_fkey FOREIGN KEY (server_id) REFERENCES infra.servers(id) ON DELETE CASCADE;


--
-- Name: resource_claims resource_claims_server_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.resource_claims
    ADD CONSTRAINT resource_claims_server_id_fkey FOREIGN KEY (server_id) REFERENCES infra.servers(id) ON DELETE RESTRICT;


--
-- Name: resource_claims resource_claims_task_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.resource_claims
    ADD CONSTRAINT resource_claims_task_id_fkey FOREIGN KEY (task_id) REFERENCES workflow.tasks(id) ON DELETE RESTRICT;


--
-- Name: server_execution_lanes server_execution_lanes_server_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.server_execution_lanes
    ADD CONSTRAINT server_execution_lanes_server_id_fkey FOREIGN KEY (server_id) REFERENCES infra.servers(id) ON DELETE CASCADE;


--
-- Name: server_execution_lanes server_execution_lanes_task_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.server_execution_lanes
    ADD CONSTRAINT server_execution_lanes_task_id_fkey FOREIGN KEY (task_id) REFERENCES workflow.tasks(id) ON DELETE RESTRICT;


--
-- Name: task_attempts task_attempts_task_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.task_attempts
    ADD CONSTRAINT task_attempts_task_id_fkey FOREIGN KEY (task_id) REFERENCES workflow.tasks(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_command_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.tasks
    ADD CONSTRAINT tasks_command_id_fkey FOREIGN KEY (command_id) REFERENCES workflow.commands(id) ON DELETE RESTRICT;


--
-- Name: tasks tasks_requested_by_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.tasks
    ADD CONSTRAINT tasks_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES iam.users(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_server_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.tasks
    ADD CONSTRAINT tasks_server_id_fkey FOREIGN KEY (server_id) REFERENCES infra.servers(id) ON DELETE RESTRICT;


--
-- Name: task_attempts workflow_task_attempt_session_fk; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.task_attempts
    ADD CONSTRAINT workflow_task_attempt_session_fk FOREIGN KEY (agent_session_id, agent_session_generation) REFERENCES workflow.agent_sessions(id, generation) ON DELETE RESTRICT;


--
-- Initial singleton rows
--

INSERT INTO iam.policy_state (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

INSERT INTO interaction.http_proxy_snapshot_state (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;


--
-- Foreign-key access-path indexes
--
-- PostgreSQL does not create indexes on referencing columns automatically.
-- Each foreign key has a valid, non-partial leading index so parent updates
-- and deletes cannot degrade into scans as the control-plane grows.

CREATE INDEX container_mounts_server_fk_idx
  ON control.container_mounts (server_id);
CREATE INDEX container_network_claims_container_fk_idx
  ON control.container_network_claims (container_id);
CREATE INDEX containers_active_task_fk_idx
  ON control.containers (active_task_id);
CREATE INDEX containers_created_by_fk_idx
  ON control.containers (created_by);
CREATE INDEX data_directories_last_task_fk_idx
  ON control.data_directories (last_task_id);
CREATE INDEX data_directories_remote_mount_fk_idx
  ON control.data_directories (remote_fs_mount_id);
CREATE INDEX data_directories_server_fk_idx
  ON control.data_directories (server_id);
CREATE INDEX quota_desired_last_task_fk_idx
  ON control.quota_desired (last_task_id);

CREATE INDEX image_grants_group_fk_idx
  ON iam.image_grants (group_id);
CREATE INDEX image_grants_user_fk_idx
  ON iam.image_grants (user_id);
CREATE INDEX mount_source_grants_group_fk_idx
  ON iam.mount_source_grants (group_id);
CREATE INDEX mount_source_grants_remote_mount_fk_idx
  ON iam.mount_source_grants (remote_fs_mount_id);
CREATE INDEX mount_source_grants_user_fk_idx
  ON iam.mount_source_grants (user_id);
CREATE INDEX refresh_tokens_user_fk_idx
  ON iam.refresh_tokens (user_id);
CREATE INDEX server_grants_group_fk_idx
  ON iam.server_grants (group_id);
CREATE INDEX server_grants_user_fk_idx
  ON iam.server_grants (user_id);

CREATE INDEX remote_fs_mounts_last_task_fk_idx
  ON infra.remote_fs_mounts (last_task_id);
CREATE INDEX remote_fs_assignments_last_task_fk_idx
  ON infra.remote_fs_server_assignments (last_task_id);

CREATE INDEX http_hostname_reservations_owner_fk_idx
  ON interaction.http_hostname_reservations (owner_id);

CREATE INDEX settings_updated_by_fk_idx
  ON system.settings (updated_by);

CREATE INDEX agent_runtime_projections_session_fk_idx
  ON workflow.agent_runtime_projections (session_id);
CREATE INDEX commands_requested_by_fk_idx
  ON workflow.commands (requested_by);
CREATE INDEX commands_server_fk_idx
  ON workflow.commands (server_id);
CREATE INDEX exec_sessions_agent_session_fk_idx
  ON workflow.exec_sessions (agent_session_id, agent_session_generation);
CREATE INDEX exec_sessions_container_fk_idx
  ON workflow.exec_sessions (container_id);
CREATE INDEX exec_sessions_server_fk_idx
  ON workflow.exec_sessions (server_id);
CREATE INDEX exec_sessions_user_fk_idx
  ON workflow.exec_sessions (user_id);
CREATE INDEX reconcile_queue_server_fk_idx
  ON workflow.reconcile_queue (server_id);
CREATE INDEX server_execution_lanes_task_fk_idx
  ON workflow.server_execution_lanes (task_id);
CREATE INDEX tasks_requested_by_fk_idx
  ON workflow.tasks (requested_by);
CREATE INDEX tasks_server_fk_idx
  ON workflow.tasks (server_id);
