--
-- Container scripts (packages/backend/src/container-scripts/): an
-- administrator's script and files that the platform runs as root inside
-- containers, once per container or after every boot. Versions are immutable;
-- each (script, container) has one target row saying whether it is due, and
-- every attempt is a run. See AGENTS.md (容器脚本).
--

-- File contents, by sha256, shared by every version that uses them.
CREATE TABLE control.container_script_blobs (
    id uuid NOT NULL PRIMARY KEY,
    sha256 text NOT NULL UNIQUE,
    content bytea NOT NULL,
    size_bytes integer NOT NULL,
    created_by uuid REFERENCES iam.users(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT container_script_blobs_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT container_script_blobs_size_check CHECK (size_bytes = octet_length(content))
);

CREATE INDEX container_script_blobs_created_by_idx ON control.container_script_blobs (created_by);

CREATE TABLE control.container_scripts (
    id uuid NOT NULL PRIMARY KEY,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    priority integer NOT NULL,
    every_boot boolean NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    pause_reason text,
    current_version integer NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    -- The current version's canary was resumed past (reset by every publish).
    canary_cleared boolean DEFAULT false NOT NULL,
    -- Failures of the current version count from here (its publish, or the last resume).
    failures_since timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by uuid REFERENCES iam.users(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT container_scripts_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 128),
    CONSTRAINT container_scripts_priority_check CHECK (priority BETWEEN 1 AND 1000000),
    CONSTRAINT container_scripts_status_check CHECK (status IN ('active', 'paused', 'archived')),
    CONSTRAINT container_scripts_pause_reason_check
        CHECK ((status = 'paused') = (pause_reason IS NOT NULL)
            AND (pause_reason IS NULL OR pause_reason IN ('manual', 'canary', 'failures'))),
    CONSTRAINT container_scripts_current_version_check CHECK (current_version > 0),
    CONSTRAINT container_scripts_revision_check CHECK (revision > 0)
);

CREATE INDEX container_scripts_created_by_idx ON control.container_scripts (created_by);

-- Archived scripts give up their name and priority.
CREATE UNIQUE INDEX container_scripts_live_name_key
    ON control.container_scripts (name) WHERE status <> 'archived';
CREATE UNIQUE INDEX container_scripts_live_priority_key
    ON control.container_scripts (priority) WHERE status <> 'archived';

CREATE TABLE control.container_script_versions (
    id uuid NOT NULL PRIMARY KEY,
    script_id uuid NOT NULL REFERENCES control.container_scripts(id) ON DELETE CASCADE,
    version integer NOT NULL,
    script text NOT NULL,
    -- Scope: all, or every non-empty list matches; excluded containers never do.
    scope_all boolean NOT NULL,
    scope_server_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    scope_image_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    scope_owner_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    scope_container_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    scope_exclude_container_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    on_new_containers boolean NOT NULL,
    apply_now boolean NOT NULL,
    stopped_policy text NOT NULL,
    timeout_seconds integer NOT NULL,
    max_attempts integer NOT NULL,
    max_parallel integer,
    max_parallel_per_server integer,
    canary_count integer,
    pause_after_failures integer,
    note text DEFAULT ''::text NOT NULL,
    published_by uuid REFERENCES iam.users(id) ON DELETE SET NULL,
    published_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT container_script_versions_script_version_key UNIQUE (script_id, version),
    CONSTRAINT container_script_versions_version_check CHECK (version > 0),
    CONSTRAINT container_script_versions_script_check CHECK (script LIKE '#!%' AND octet_length(script) <= 65536),
    CONSTRAINT container_script_versions_scope_check CHECK (
        scope_all <> (cardinality(scope_server_ids) + cardinality(scope_image_ids)
            + cardinality(scope_owner_ids) + cardinality(scope_container_ids) > 0)
    ),
    CONSTRAINT container_script_versions_stopped_policy_check CHECK (stopped_policy IN ('wait', 'skip')),
    CONSTRAINT container_script_versions_timeout_check CHECK (timeout_seconds BETWEEN 10 AND 86400),
    CONSTRAINT container_script_versions_attempts_check CHECK (max_attempts BETWEEN 1 AND 10),
    CONSTRAINT container_script_versions_parallel_check CHECK (max_parallel IS NULL OR max_parallel > 0),
    CONSTRAINT container_script_versions_parallel_per_server_check
        CHECK (max_parallel_per_server IS NULL OR max_parallel_per_server > 0),
    CONSTRAINT container_script_versions_canary_check CHECK (canary_count IS NULL OR canary_count > 0),
    CONSTRAINT container_script_versions_pause_check CHECK (pause_after_failures IS NULL OR pause_after_failures > 0)
);

CREATE INDEX container_script_versions_published_by_idx ON control.container_script_versions (published_by);

CREATE TABLE control.container_script_files (
    version_id uuid NOT NULL REFERENCES control.container_script_versions(id) ON DELETE CASCADE,
    position integer NOT NULL,
    name text NOT NULL,
    blob_id uuid NOT NULL REFERENCES control.container_script_blobs(id) ON DELETE RESTRICT,
    destination_path text,
    destination_mode integer,
    destination_owner text,
    PRIMARY KEY (version_id, name),
    CONSTRAINT container_script_files_name_check CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
    CONSTRAINT container_script_files_destination_check CHECK (
        (destination_path IS NULL) = (destination_mode IS NULL)
        AND (destination_path IS NULL) = (destination_owner IS NULL)
    ),
    CONSTRAINT container_script_files_path_check CHECK (destination_path IS NULL OR destination_path LIKE '/%'),
    CONSTRAINT container_script_files_mode_check CHECK (destination_mode IS NULL OR destination_mode BETWEEN 0 AND 4095),
    CONSTRAINT container_script_files_owner_check
        CHECK (destination_owner IS NULL OR destination_owner IN ('root', 'login_user'))
);

CREATE INDEX container_script_files_blob_idx ON control.container_script_files (blob_id);

-- What the script scheduler last saw of each instance: its status and the
-- boot it is in (Incus `last_used_at`, which changes on every start and
-- in-guest reboot and on nothing else).
CREATE TABLE control.container_boot_observations (
    container_id uuid NOT NULL PRIMARY KEY REFERENCES control.containers(id) ON DELETE CASCADE,
    server_id uuid NOT NULL,
    instance_status text NOT NULL,
    boot_id text,
    observed_at timestamp with time zone NOT NULL
);

CREATE TABLE control.container_script_runs (
    id uuid NOT NULL PRIMARY KEY,
    script_id uuid NOT NULL REFERENCES control.container_scripts(id) ON DELETE CASCADE,
    version_id uuid NOT NULL REFERENCES control.container_script_versions(id) ON DELETE CASCADE,
    -- The version's number, kept with the run for display.
    version integer NOT NULL,
    container_id uuid NOT NULL REFERENCES control.containers(id) ON DELETE CASCADE,
    server_id uuid NOT NULL,
    trigger text NOT NULL,
    attempt integer NOT NULL,
    boot_id text,
    status text NOT NULL,
    exit_code integer,
    output text DEFAULT ''::text NOT NULL,
    error text,
    -- When a run still without a result is given up as interrupted.
    deadline_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT container_script_runs_trigger_check CHECK (trigger IN ('now', 'new_container', 'boot', 'retry')),
    CONSTRAINT container_script_runs_attempt_check CHECK (attempt > 0),
    CONSTRAINT container_script_runs_status_check
        CHECK (status IN ('running', 'succeeded', 'failed', 'timed_out', 'interrupted')),
    CONSTRAINT container_script_runs_finished_check CHECK ((status = 'running') = (finished_at IS NULL))
);

-- Runs on one container never overlap, whatever the scheduler believes.
CREATE UNIQUE INDEX container_script_runs_one_running_per_container
    ON control.container_script_runs (container_id) WHERE status = 'running';
CREATE INDEX container_script_runs_script_started_idx
    ON control.container_script_runs (script_id, started_at DESC, id DESC);
CREATE INDEX container_script_runs_version_idx ON control.container_script_runs (version_id);
CREATE INDEX container_script_runs_container_started_idx
    ON control.container_script_runs (container_id, script_id, started_at DESC);

-- Where each container stands with each script. once: due while target_version
-- is newer than succeeded_version; every boot: the state is about boot_id.
CREATE TABLE control.container_script_targets (
    script_id uuid NOT NULL REFERENCES control.container_scripts(id) ON DELETE CASCADE,
    container_id uuid NOT NULL REFERENCES control.containers(id) ON DELETE CASCADE,
    state text NOT NULL,
    target_version integer,
    succeeded_version integer,
    boot_id text,
    -- Every boot, exempt at a publish that had not observed the container's boot:
    -- a boot that started no later than this is the one current at the publish.
    boot_after timestamp with time zone,
    trigger text,
    -- A version with applyNow was published while this container ran an older one.
    rerun boolean DEFAULT false NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    last_run_id uuid REFERENCES control.container_script_runs(id) ON DELETE SET NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    PRIMARY KEY (script_id, container_id),
    CONSTRAINT container_script_targets_state_check
        CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'exempt')),
    CONSTRAINT container_script_targets_trigger_check
        CHECK (trigger IS NULL OR trigger IN ('now', 'new_container', 'boot', 'retry')),
    CONSTRAINT container_script_targets_attempts_check CHECK (attempts >= 0)
);

CREATE INDEX container_script_targets_container_idx ON control.container_script_targets (container_id);
CREATE INDEX container_script_targets_last_run_idx ON control.container_script_targets (last_run_id);
CREATE INDEX container_script_targets_pending_idx
    ON control.container_script_targets (container_id) WHERE state = 'pending';
