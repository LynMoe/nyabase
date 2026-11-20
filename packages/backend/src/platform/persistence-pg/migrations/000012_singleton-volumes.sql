--
-- One volume per user and disk, sized by the platform (AGENTS.md, 数据盘与共享盘).
--
-- * A data-disk grant becomes a group of local pools of one server sharing one
--   quota (iam.data_disk_grants); iam.storage_pool_grants keeps one row per
--   (user, pool) and says which group the pool belongs to. Every existing
--   grant becomes a group of its one pool, with the same quota and id, so the
--   effective coverage is unchanged (checked below) and nothing lapses.
-- * Storage grants always have a size: an unlimited data-disk or shared
--   backend grant stops the migration (set a size first, then upgrade).
-- * A disk (local pool or shared backend) with a mount path is enabled: each
--   covered user gets one volume on it, mounted there in all of their
--   containers. Shared backends start disabled (their old default mount point
--   was only a form suggestion); maintenance leaves a disk out of containers.
-- * At most one live volume per (user, pool) and per (user, shared backend).
--

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM iam.storage_pool_grants WHERE limit_bytes IS NULL)
        OR EXISTS (SELECT 1 FROM iam.shared_backend_grants WHERE limit_bytes IS NULL)
    THEN
        RAISE EXCEPTION '000012: give every unlimited data-disk and shared backend grant a size before upgrading'
            USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
        SELECT 1 FROM control.volumes
        WHERE lifecycle_phase <> 'deleting' AND pool_id IS NOT NULL
        GROUP BY owner_id, pool_id HAVING count(*) > 1
    ) OR EXISTS (
        SELECT 1 FROM control.volumes
        WHERE lifecycle_phase <> 'deleting' AND shared_backend_id IS NOT NULL
        GROUP BY owner_id, shared_backend_id HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION '000012: a user has several volumes on one pool or shared backend; merge them before upgrading'
            USING ERRCODE = '23505';
    END IF;
END $$;

CREATE TEMPORARY TABLE pool_access_before ON COMMIT DROP AS
SELECT user_id, pool_id, limit_bytes, expires_at FROM iam.effective_pool_access;

-- Data-disk grants ----------------------------------------------------------

CREATE TABLE iam.data_disk_grants (
    id uuid NOT NULL,
    server_grant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    server_id uuid NOT NULL,
    limit_bytes bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT data_disk_grants_pkey PRIMARY KEY (id),
    CONSTRAINT data_disk_grants_identity_key UNIQUE (id, user_id, server_id),
    CONSTRAINT data_disk_grants_server_grant_fkey
        FOREIGN KEY (server_grant_id, user_id, server_id)
        REFERENCES iam.server_grants(id, user_id, server_id) ON DELETE CASCADE,
    CONSTRAINT data_disk_grants_limit_check CHECK (limit_bytes > 0)
);

CREATE INDEX data_disk_grants_server_grant_idx
    ON iam.data_disk_grants (server_grant_id, user_id, server_id);
CREATE INDEX data_disk_grants_user_server_idx ON iam.data_disk_grants (user_id, server_id);

CREATE TRIGGER iam_data_disk_grants_touch_updated_at
BEFORE UPDATE ON iam.data_disk_grants
FOR EACH ROW EXECUTE FUNCTION iam.touch_updated_at();

INSERT INTO iam.data_disk_grants (id, server_grant_id, user_id, server_id, limit_bytes, created_at, updated_at)
SELECT id, server_grant_id, user_id, server_id, limit_bytes, created_at, updated_at
FROM iam.storage_pool_grants;

ALTER TABLE iam.storage_pool_grants ADD COLUMN data_disk_grant_id uuid;
UPDATE iam.storage_pool_grants SET data_disk_grant_id = id;
ALTER TABLE iam.storage_pool_grants
    ALTER COLUMN data_disk_grant_id SET NOT NULL,
    ADD CONSTRAINT storage_pool_grants_data_disk_grant_fkey
        FOREIGN KEY (data_disk_grant_id, user_id, server_id)
        REFERENCES iam.data_disk_grants(id, user_id, server_id) ON DELETE CASCADE;
CREATE INDEX storage_pool_grants_data_disk_grant_idx
    ON iam.storage_pool_grants (data_disk_grant_id, user_id, server_id);

-- The quota is the group's; a pool is covered while its server grant is current.
CREATE OR REPLACE VIEW iam.effective_pool_access AS
SELECT pools.user_id,
       pools.pool_id,
       disks.limit_bytes,
       grants.expires_at,
       pools.data_disk_grant_id
FROM iam.storage_pool_grants AS pools
JOIN iam.data_disk_grants AS disks ON disks.id = pools.data_disk_grant_id
JOIN iam.server_grants AS grants ON grants.id = pools.server_grant_id
JOIN iam.users AS users ON users.id = pools.user_id AND users.status = 'active'
WHERE grants.expires_at IS NULL OR grants.expires_at > now();

ALTER TABLE iam.storage_pool_grants DROP COLUMN limit_bytes;

ALTER TABLE iam.shared_backend_grants ALTER COLUMN limit_bytes SET NOT NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT * FROM pool_access_before
        EXCEPT SELECT user_id, pool_id, limit_bytes, expires_at FROM iam.effective_pool_access
    ) OR EXISTS (
        SELECT user_id, pool_id, limit_bytes, expires_at FROM iam.effective_pool_access
        EXCEPT SELECT * FROM pool_access_before
    ) THEN
        RAISE EXCEPTION '000012: converting data-disk grants changed effective pool access';
    END IF;
END $$;

-- Disks: mount paths and maintenance ---------------------------------------

ALTER TABLE infra.storage_pools
    ADD COLUMN mount_path text,
    ADD COLUMN maintenance boolean DEFAULT false NOT NULL,
    ADD CONSTRAINT storage_pools_mount_path_check
        CHECK (mount_path IS NULL OR (length(mount_path) BETWEEN 2 AND 4096 AND mount_path LIKE '/%'));
CREATE UNIQUE INDEX storage_pools_mount_path_unique
    ON infra.storage_pools (server_id, mount_path) WHERE mount_path IS NOT NULL;

ALTER TABLE infra.shared_backends RENAME COLUMN default_mount_path TO mount_path;
ALTER TABLE infra.shared_backends
    RENAME CONSTRAINT shared_backends_default_mount_path_check TO shared_backends_mount_path_check;
UPDATE infra.shared_backends SET mount_path = NULL;
ALTER TABLE infra.shared_backends
    ADD COLUMN maintenance boolean DEFAULT false NOT NULL,
    DROP COLUMN max_volumes_per_user;

-- Volumes: one per (user, disk) ----------------------------------------------

CREATE UNIQUE INDEX volumes_owner_pool_singleton
    ON control.volumes (owner_id, pool_id)
    WHERE pool_id IS NOT NULL AND lifecycle_phase <> 'deleting';
CREATE UNIQUE INDEX volumes_owner_shared_backend_singleton
    ON control.volumes (owner_id, shared_backend_id)
    WHERE shared_backend_id IS NOT NULL AND lifecycle_phase <> 'deleting';

-- A mount whose path already holds files in the container waits as `blocked`.
ALTER TABLE control.volume_attachments DROP CONSTRAINT volume_attachments_bind_state_check;
ALTER TABLE control.volume_attachments ADD CONSTRAINT volume_attachments_bind_state_check
    CHECK (bind_state = ANY (ARRAY['attaching', 'attached', 'detaching', 'blocked']));
