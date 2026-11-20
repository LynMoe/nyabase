--
-- One disk quota per server grant (AGENTS.md, 授权模型).
--
-- * A bundle defines `disk_bytes`: the user's system disks and data disks on
--   the server together (system disks count by their committed size, data
--   disks by the data on them). It is required: there is no unlimited total.
--   `root_disk_bytes` stays as the system disks' own ceiling (NULL = only the
--   total).
-- * The data disks belong to the bundle: `iam.grant_bundle_disks` lists local
--   pools of its server, each with an optional ceiling (`cap_bytes`, NULL =
--   only the total). A grant follows that list unless it overrides
--   `data_disks`; its own list is then in `iam.storage_pool_grants`. A grant
--   overrides `disk` like any other quota.
-- * Data-disk grants (groups of pools sharing a limit) go away. A server grant
--   that had some keeps its coverage and never gets less room: it overrides
--   `disk` with its system-disk quota (or its live system disks, where they
--   are over it) plus the groups' limits, and `data_disks` with its pools,
--   each capped at its group's limit. Bundles get
--   `disk_bytes = root_disk_bytes`; a grant overriding only its system-disk
--   quota overrides `disk` with the same value, so every other grant keeps
--   exactly the room it had.
-- * An unlimited system-disk quota (bundle or override) stops the migration:
--   the total it would become cannot be unlimited. Give it a size first.
--

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM iam.grant_bundles WHERE root_disk_bytes IS NULL)
        OR EXISTS (
            SELECT 1 FROM iam.server_grants
            WHERE 'root_disk' = ANY (overridden) AND root_disk_bytes IS NULL
        )
    THEN
        RAISE EXCEPTION '000014: give every unlimited system-disk quota (bundles and grant overrides) a size before upgrading'
            USING ERRCODE = '23514';
    END IF;
END $$;

CREATE TEMPORARY TABLE server_access_before ON COMMIT DROP AS
SELECT user_id, server_id, cpu_cores, mem_bytes, root_disk_bytes, gpu_count, gpu_pci_addresses, expires_at
FROM iam.effective_server_access;

CREATE TEMPORARY TABLE pool_access_before ON COMMIT DROP AS
SELECT user_id, pool_id, expires_at FROM iam.effective_pool_access;

-- The total each server grant gets: its system-disk quota plus its data-disk
-- limits. A grant with data disks whose live system disks already exceed
-- their quota (it was lowered after they were made) counts them instead, so
-- its data disks keep all their room.
CREATE TEMPORARY TABLE disk_total ON COMMIT DROP AS
WITH grants AS (
    SELECT grants.id,
           CASE WHEN 'root_disk' = ANY (grants.overridden) THEN grants.root_disk_bytes
                ELSE bundles.root_disk_bytes END AS root_disk_bytes,
           (SELECT sum(disks.limit_bytes) FROM iam.data_disk_grants AS disks
            WHERE disks.server_grant_id = grants.id) AS data_bytes,
           (SELECT coalesce(sum(greatest(containers.root_size_bytes,
                                         coalesce(containers.root_size_pending_bytes, 0),
                                         coalesce(containers.root_shrink_reserved_bytes, 0))), 0)
            FROM control.containers AS containers
            WHERE containers.owner_id = grants.user_id
              AND containers.server_id = grants.server_id
              AND containers.lifecycle_phase NOT IN ('failed', 'deleting')) AS root_committed_bytes
    FROM iam.server_grants AS grants
    JOIN iam.grant_bundles AS bundles ON bundles.id = grants.bundle_id
)
SELECT grants.id AS server_grant_id,
       (CASE WHEN grants.data_bytes IS NULL THEN grants.root_disk_bytes
             ELSE greatest(grants.root_disk_bytes, grants.root_committed_bytes) + grants.data_bytes
        END)::bigint AS disk_bytes,
       grants.data_bytes IS NOT NULL AS has_data_disks
FROM grants;

DROP VIEW iam.effective_pool_access;
DROP VIEW iam.effective_server_access;

-- Bundles: the total and the data-disk list ----------------------------------

ALTER TABLE iam.grant_bundles ADD COLUMN disk_bytes bigint;
UPDATE iam.grant_bundles SET disk_bytes = root_disk_bytes;
ALTER TABLE iam.grant_bundles
    ALTER COLUMN disk_bytes SET NOT NULL,
    ADD CONSTRAINT grant_bundles_disk_bytes_check CHECK (disk_bytes > 0);

COMMENT ON COLUMN iam.grant_bundles.disk_bytes IS
  'System disks (committed size) and data disks (data) of a user on the server together';
COMMENT ON COLUMN iam.grant_bundles.root_disk_bytes IS
  'Ceiling of the system disks alone; NULL = only disk_bytes';

CREATE TABLE iam.grant_bundle_disks (
    bundle_id uuid NOT NULL,
    server_id uuid NOT NULL,
    pool_id uuid NOT NULL,
    -- NULL = only the bundle's total.
    cap_bytes bigint,
    CONSTRAINT grant_bundle_disks_pkey PRIMARY KEY (bundle_id, pool_id),
    CONSTRAINT grant_bundle_disks_bundle_fkey FOREIGN KEY (bundle_id, server_id)
        REFERENCES iam.grant_bundles(id, server_id) ON DELETE CASCADE,
    CONSTRAINT grant_bundle_disks_pool_fkey FOREIGN KEY (pool_id, server_id)
        REFERENCES infra.storage_pools(id, server_id) ON DELETE RESTRICT,
    CONSTRAINT grant_bundle_disks_cap_check CHECK (cap_bytes IS NULL OR cap_bytes > 0)
);

CREATE INDEX grant_bundle_disks_bundle_idx ON iam.grant_bundle_disks (bundle_id, server_id);
CREATE INDEX grant_bundle_disks_pool_idx ON iam.grant_bundle_disks (pool_id, server_id);

-- Server grants: `disk` and `data_disks` overrides ---------------------------

ALTER TABLE iam.server_grants
    DROP CONSTRAINT server_grants_overridden_check,
    ADD COLUMN disk_bytes bigint;

-- A grant with data disks overrides both; one that only overrides its
-- system-disk quota overrides `disk` with it too (else the bundle's smaller
-- or larger total would apply).
UPDATE iam.server_grants AS grants
SET overridden = grants.overridden || ARRAY['disk']::text[]
        || CASE WHEN totals.has_data_disks THEN ARRAY['data_disks']::text[] ELSE ARRAY[]::text[] END,
    disk_bytes = totals.disk_bytes
FROM disk_total AS totals, iam.grant_bundles AS bundles
WHERE totals.server_grant_id = grants.id
  AND bundles.id = grants.bundle_id
  AND (totals.has_data_disks OR totals.disk_bytes <> bundles.disk_bytes);

-- A field named in `overridden` takes this row's value; `disk` has no
-- unlimited value, so its column is set exactly when it is overridden.
ALTER TABLE iam.server_grants
    ADD CONSTRAINT server_grants_overridden_check
        CHECK (overridden <@ ARRAY['cpu', 'mem', 'disk', 'root_disk', 'gpu', 'data_disks']::text[]
               AND array_position(overridden, NULL::text) IS NULL),
    ADD CONSTRAINT server_grants_disk_bytes_check
        CHECK ((disk_bytes IS NOT NULL) = ('disk' = ANY (overridden))
               AND (disk_bytes IS NULL OR disk_bytes > 0));

-- A grant's own data-disk list (only read while it overrides `data_disks`).
ALTER TABLE iam.storage_pool_grants
    ADD COLUMN cap_bytes bigint,
    ADD CONSTRAINT storage_pool_grants_cap_check CHECK (cap_bytes IS NULL OR cap_bytes > 0);

UPDATE iam.storage_pool_grants AS pools
SET cap_bytes = disks.limit_bytes
FROM iam.data_disk_grants AS disks
WHERE disks.id = pools.data_disk_grant_id;

ALTER TABLE iam.storage_pool_grants DROP COLUMN data_disk_grant_id;
DROP TABLE iam.data_disk_grants;

COMMENT ON TABLE iam.storage_pool_grants IS
  'Data disks of a server grant that overrides data_disks (its bundle''s list otherwise)';

-- Effective access ------------------------------------------------------------

-- As in 000003, plus the disk total (the override where there is one, else the bundle's).
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
           grants.expires_at,
           CASE WHEN 'disk' = ANY (grants.overridden) THEN grants.disk_bytes
                ELSE bundles.disk_bytes END AS disk_bytes
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
       current_grants.expires_at,
       current_grants.disk_bytes
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

-- A data disk is covered while its server grant is current: the bundle's list,
-- or the grant's own while it overrides `data_disks`.
CREATE VIEW iam.effective_pool_access AS
SELECT grants.user_id,
       disks.pool_id,
       disks.cap_bytes,
       grants.expires_at,
       grants.server_id,
       grants.id AS server_grant_id
FROM iam.server_grants AS grants
JOIN iam.users AS users ON users.id = grants.user_id AND users.status = 'active'
CROSS JOIN LATERAL (
    SELECT bundle_disks.pool_id, bundle_disks.cap_bytes
    FROM iam.grant_bundle_disks AS bundle_disks
    WHERE bundle_disks.bundle_id = grants.bundle_id
      AND NOT ('data_disks' = ANY (grants.overridden))
    UNION ALL
    SELECT own.pool_id, own.cap_bytes
    FROM iam.storage_pool_grants AS own
    WHERE own.server_grant_id = grants.id
      AND 'data_disks' = ANY (grants.overridden)
) AS disks
WHERE grants.expires_at IS NULL OR grants.expires_at > now();

DO $$
BEGIN
    IF EXISTS (
        SELECT * FROM server_access_before
        EXCEPT SELECT user_id, server_id, cpu_cores, mem_bytes, root_disk_bytes, gpu_count, gpu_pci_addresses, expires_at
               FROM iam.effective_server_access
    ) OR EXISTS (
        SELECT user_id, server_id, cpu_cores, mem_bytes, root_disk_bytes, gpu_count, gpu_pci_addresses, expires_at
        FROM iam.effective_server_access
        EXCEPT SELECT * FROM server_access_before
    ) THEN
        RAISE EXCEPTION '000014: converting server grants changed effective server access';
    END IF;
    IF EXISTS (
        SELECT * FROM pool_access_before
        EXCEPT SELECT user_id, pool_id, expires_at FROM iam.effective_pool_access
    ) OR EXISTS (
        SELECT user_id, pool_id, expires_at FROM iam.effective_pool_access
        EXCEPT SELECT * FROM pool_access_before
    ) THEN
        RAISE EXCEPTION '000014: converting data-disk grants changed effective pool access';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM iam.server_grants AS grants
        JOIN iam.grant_bundles AS bundles ON bundles.id = grants.bundle_id
        JOIN disk_total AS totals ON totals.server_grant_id = grants.id
        WHERE CASE WHEN 'disk' = ANY (grants.overridden) THEN grants.disk_bytes
                   ELSE bundles.disk_bytes END <> totals.disk_bytes
    ) THEN
        RAISE EXCEPTION '000014: a server grant''s disk total is not the one computed from its old quotas';
    END IF;
END $$;
