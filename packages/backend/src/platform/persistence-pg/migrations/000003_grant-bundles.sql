--
-- Grant bundles replace groups. A bundle is a named set of server quotas
-- (CPU, memory, system disk, GPU count) bound to one server; a user holds at
-- most one bundle per server (iam.server_grants), optionally overriding any of
-- its fields. A non-overridden field follows the bundle: editing the bundle
-- changes every grant that does not override that field. Data disks are
-- granted per user under the server grant (iam.storage_pool_grants, one quota
-- per pool) and live and die with it. Shared backends keep their own grants.
--
-- Existing server and storage-pool grants and all groups are dropped without
-- conversion: until the administrators assign bundles, every user loses
-- server and pool coverage and the access-lapse grace starts. Shared-backend
-- grants are kept (those held through a group move to its members).
--

DROP VIEW iam.effective_server_access;
DROP VIEW iam.effective_pool_access;
DROP VIEW iam.effective_shared_backend_access;

DROP TABLE iam.storage_pool_grants;
DROP TABLE iam.server_grants;

-- Shared-backend grants stay, one per (user, backend): a grant held through a
-- group becomes a grant of each member, merged with the member's own as the old
-- view merged them (largest limit, NULL winning; latest expiry, NULL winning),
-- so nobody loses a backend, and the CephFS volumes on it, to this migration.
INSERT INTO iam.shared_backend_grants (id, user_id, group_id, shared_backend_id, limit_bytes, expires_at)
SELECT gen_random_uuid(), members.user_id, NULL, grants.shared_backend_id,
       CASE WHEN bool_or(grants.limit_bytes IS NULL) THEN NULL ELSE max(grants.limit_bytes) END,
       CASE WHEN bool_or(grants.expires_at IS NULL) THEN NULL ELSE max(grants.expires_at) END
FROM iam.shared_backend_grants AS grants
JOIN iam.group_members AS members ON members.group_id = grants.group_id
GROUP BY members.user_id, grants.shared_backend_id
ON CONFLICT (user_id, shared_backend_id) WHERE user_id IS NOT NULL DO UPDATE SET
    limit_bytes = CASE
        WHEN iam.shared_backend_grants.limit_bytes IS NULL OR EXCLUDED.limit_bytes IS NULL THEN NULL
        ELSE greatest(iam.shared_backend_grants.limit_bytes, EXCLUDED.limit_bytes) END,
    expires_at = CASE
        WHEN iam.shared_backend_grants.expires_at IS NULL OR EXCLUDED.expires_at IS NULL THEN NULL
        ELSE greatest(iam.shared_backend_grants.expires_at, EXCLUDED.expires_at) END;
DELETE FROM iam.shared_backend_grants WHERE group_id IS NOT NULL;
DROP INDEX iam.shared_backend_grants_user_unique;
ALTER TABLE iam.shared_backend_grants
    DROP CONSTRAINT shared_backend_grants_scope_check,
    DROP COLUMN group_id,
    ALTER COLUMN user_id SET NOT NULL;
CREATE UNIQUE INDEX shared_backend_grants_user_unique
    ON iam.shared_backend_grants (user_id, shared_backend_id);

DROP TABLE iam.group_members;
DROP TABLE iam.groups;

-- NVIDIA cards last seen in the server's Incus resources (canonical PCI
-- addresses, sorted); the GPUs a grant allows are picked from these.
ALTER TABLE infra.servers
    ADD COLUMN observed_gpu_pci_addresses text[] DEFAULT ARRAY[]::text[] NOT NULL,
    ADD CONSTRAINT servers_observed_gpu_pci_addresses_check
        CHECK (array_position(observed_gpu_pci_addresses, NULL::text) IS NULL
               AND array_to_string(observed_gpu_pci_addresses, ',') !~ '[^0-9a-f:.,]');

ALTER TABLE infra.storage_pools
    ADD CONSTRAINT storage_pools_id_server_id_key UNIQUE (id, server_id);

CREATE TABLE iam.grant_bundles (
    id uuid NOT NULL,
    server_id uuid NOT NULL REFERENCES infra.servers(id) ON DELETE RESTRICT,
    name text NOT NULL,
    -- NULL = unlimited (every unreserved CPU / no memory or system-disk limit / every card).
    cpu_cores integer,
    mem_bytes bigint,
    root_disk_bytes bigint,
    gpu_count integer,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT grant_bundles_pkey PRIMARY KEY (id),
    CONSTRAINT grant_bundles_id_server_id_key UNIQUE (id, server_id),
    CONSTRAINT grant_bundles_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 64),
    CONSTRAINT grant_bundles_cpu_cores_check CHECK (cpu_cores IS NULL OR cpu_cores > 0),
    CONSTRAINT grant_bundles_mem_bytes_check CHECK (mem_bytes IS NULL OR mem_bytes > 0),
    CONSTRAINT grant_bundles_root_disk_bytes_check
        CHECK (root_disk_bytes IS NULL OR root_disk_bytes > 0),
    CONSTRAINT grant_bundles_gpu_count_check CHECK (gpu_count IS NULL OR gpu_count >= 0),
    CONSTRAINT grant_bundles_revision_check CHECK (revision >= 1)
);

CREATE UNIQUE INDEX grant_bundles_server_name_key
    ON iam.grant_bundles (server_id, lower(btrim(name)));

-- One bundle per (user, server). A field named in `overridden` takes this
-- row's value (NULL = unlimited); any other field reads the bundle's, and its
-- column here stays NULL.
CREATE TABLE iam.server_grants (
    id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES infra.servers(id) ON DELETE RESTRICT,
    bundle_id uuid NOT NULL,
    overridden text[] DEFAULT ARRAY[]::text[] NOT NULL,
    cpu_cores integer,
    mem_bytes bigint,
    root_disk_bytes bigint,
    gpu_count integer,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT server_grants_pkey PRIMARY KEY (id),
    CONSTRAINT server_grants_user_server_key UNIQUE (user_id, server_id),
    CONSTRAINT server_grants_id_user_server_key UNIQUE (id, user_id, server_id),
    CONSTRAINT server_grants_bundle_fkey FOREIGN KEY (bundle_id, server_id)
        REFERENCES iam.grant_bundles(id, server_id) ON DELETE RESTRICT,
    CONSTRAINT server_grants_overridden_check
        CHECK (overridden <@ ARRAY['cpu', 'mem', 'root_disk', 'gpu']::text[]
               AND array_position(overridden, NULL::text) IS NULL),
    CONSTRAINT server_grants_cpu_cores_check
        CHECK (cpu_cores IS NULL OR (cpu_cores > 0 AND 'cpu' = ANY (overridden))),
    CONSTRAINT server_grants_mem_bytes_check
        CHECK (mem_bytes IS NULL OR (mem_bytes > 0 AND 'mem' = ANY (overridden))),
    CONSTRAINT server_grants_root_disk_bytes_check
        CHECK (root_disk_bytes IS NULL OR (root_disk_bytes > 0 AND 'root_disk' = ANY (overridden))),
    CONSTRAINT server_grants_gpu_count_check
        CHECK (gpu_count IS NULL OR (gpu_count >= 0 AND 'gpu' = ANY (overridden)))
);

CREATE INDEX server_grants_bundle_idx ON iam.server_grants (bundle_id, server_id);
CREATE INDEX server_grants_server_idx ON iam.server_grants (server_id);
CREATE INDEX server_grants_expires_at_idx
    ON iam.server_grants (expires_at) WHERE expires_at IS NOT NULL;

-- A data-disk quota on one local pool of the grant's server. It has no expiry
-- of its own: it is current exactly while its server grant is, and goes with it.
CREATE TABLE iam.storage_pool_grants (
    id uuid NOT NULL,
    server_grant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    server_id uuid NOT NULL,
    pool_id uuid NOT NULL,
    -- NULL = unlimited.
    limit_bytes bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT storage_pool_grants_pkey PRIMARY KEY (id),
    CONSTRAINT storage_pool_grants_user_pool_key UNIQUE (user_id, pool_id),
    CONSTRAINT storage_pool_grants_server_grant_fkey
        FOREIGN KEY (server_grant_id, user_id, server_id)
        REFERENCES iam.server_grants(id, user_id, server_id) ON DELETE CASCADE,
    CONSTRAINT storage_pool_grants_pool_fkey FOREIGN KEY (pool_id, server_id)
        REFERENCES infra.storage_pools(id, server_id) ON DELETE RESTRICT,
    CONSTRAINT storage_pool_grants_limit_check CHECK (limit_bytes IS NULL OR limit_bytes > 0)
);

CREATE INDEX storage_pool_grants_server_grant_idx
    ON iam.storage_pool_grants (server_grant_id, user_id, server_id);
CREATE INDEX storage_pool_grants_pool_idx ON iam.storage_pool_grants (pool_id, server_id);

CREATE TRIGGER iam_grant_bundles_touch_updated_at
BEFORE UPDATE ON iam.grant_bundles
FOR EACH ROW EXECUTE FUNCTION iam.touch_updated_at();
CREATE TRIGGER iam_server_grants_touch_updated_at
BEFORE UPDATE ON iam.server_grants
FOR EACH ROW EXECUTE FUNCTION iam.touch_updated_at();
CREATE TRIGGER iam_storage_pool_grants_touch_updated_at
BEFORE UPDATE ON iam.storage_pool_grants
FOR EACH ROW EXECUTE FUNCTION iam.touch_updated_at();

-- Effective access: the current grants of active users. A pair with no
-- current grant, or whose user is not active, has no row: disabling a user
-- loses coverage like an expired or revoked grant.
--   * Server quotas are the grant's override where it has one, else the bundle's.
--   * The GPUs are the first `gpu_count` (NULL = all) of the server's observed
--     cards ranked by md5(user id, PCI address): the choice depends only on the
--     user and the card list, raising the count keeps the cards already picked,
--     and a card appearing or disappearing moves only the users it ranks for.
--   * A pool grant is current while its server grant is.
CREATE VIEW iam.effective_server_access AS
WITH current_grants AS (
    SELECT grants.user_id,
           grants.server_id,
           CASE WHEN 'cpu' = ANY (grants.overridden) THEN grants.cpu_cores
                ELSE bundles.cpu_cores END AS cpu_cores,
           CASE WHEN 'mem' = ANY (grants.overridden) THEN grants.mem_bytes
                ELSE bundles.mem_bytes END AS mem_bytes,
           CASE WHEN 'root_disk' = ANY (grants.overridden) THEN grants.root_disk_bytes
                ELSE bundles.root_disk_bytes END AS root_disk_bytes,
           CASE WHEN 'gpu' = ANY (grants.overridden) THEN grants.gpu_count
                ELSE bundles.gpu_count END AS gpu_count,
           grants.expires_at
    FROM iam.server_grants AS grants
    JOIN iam.grant_bundles AS bundles ON bundles.id = grants.bundle_id
    JOIN iam.users AS users ON users.id = grants.user_id AND users.status = 'active'
    WHERE grants.expires_at IS NULL OR grants.expires_at > now()
)
SELECT current_grants.user_id,
       current_grants.server_id,
       current_grants.cpu_cores,
       current_grants.mem_bytes,
       current_grants.root_disk_bytes,
       current_grants.gpu_count,
       coalesce(picked.gpu_pci_addresses, ARRAY[]::text[]) AS gpu_pci_addresses,
       current_grants.expires_at
FROM current_grants
JOIN infra.servers AS servers ON servers.id = current_grants.server_id
LEFT JOIN LATERAL (
    SELECT array_agg(ranked.address ORDER BY ranked.address COLLATE "C") AS gpu_pci_addresses
    FROM (
        SELECT address
        FROM unnest(servers.observed_gpu_pci_addresses) AS address
        ORDER BY md5(current_grants.user_id::text || '/' || address) COLLATE "C",
                 address COLLATE "C"
        LIMIT current_grants.gpu_count
    ) AS ranked
) AS picked ON true;

CREATE VIEW iam.effective_pool_access AS
SELECT pools.user_id,
       pools.pool_id,
       pools.limit_bytes,
       grants.expires_at
FROM iam.storage_pool_grants AS pools
JOIN iam.server_grants AS grants ON grants.id = pools.server_grant_id
JOIN iam.users AS users ON users.id = pools.user_id AND users.status = 'active'
WHERE grants.expires_at IS NULL OR grants.expires_at > now();

CREATE VIEW iam.effective_shared_backend_access AS
SELECT grants.user_id,
       grants.shared_backend_id,
       grants.limit_bytes,
       grants.expires_at
FROM iam.shared_backend_grants AS grants
JOIN iam.users AS users ON users.id = grants.user_id AND users.status = 'active'
WHERE grants.expires_at IS NULL OR grants.expires_at > now();
