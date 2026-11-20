--
-- Storage pool roles (AGENTS.md, 存储池用途与系统盘分配).
--
-- * A local pool can be a system disk (root disks of new containers go there)
--   and / or a data disk (mount_path, unchanged). The system role moves from
--   infra.servers.system_pool_id onto the pool, with its parameters: a weight
--   for random placement and a high-water mark on observed usage. Turning the
--   role off keeps existing root disks where they are.
-- * A server places new root disks by `single` (at most one system pool) or
--   `random` (weighted, optionally sticky per user: a user's next container
--   goes to the pool holding most of their live root disks on that server).
-- * Every server starts `single` with its former system pool, so nothing
--   changes until an administrator says so.
--

ALTER TABLE infra.storage_pools
    ADD COLUMN system_disk boolean DEFAULT false NOT NULL,
    ADD COLUMN system_weight integer DEFAULT 1 NOT NULL,
    ADD COLUMN system_max_used_percent smallint,
    ADD CONSTRAINT storage_pools_system_disk_check
        CHECK (NOT system_disk OR (registered AND root_disk_capable AND NOT shareable)),
    ADD CONSTRAINT storage_pools_system_params_check
        CHECK (system_weight BETWEEN 1 AND 100
            AND (system_max_used_percent IS NULL OR system_max_used_percent BETWEEN 1 AND 100)
            AND (system_disk OR (system_weight = 1 AND system_max_used_percent IS NULL)));

COMMENT ON COLUMN infra.storage_pools.system_weight IS
  'Relative chance of this system pool under random root placement';
COMMENT ON COLUMN infra.storage_pools.system_max_used_percent IS
  'No new root disk lands here once observed used / total reaches this percentage; NULL = no mark';

ALTER TABLE infra.servers
    ADD COLUMN root_placement text DEFAULT 'single' NOT NULL,
    ADD COLUMN root_placement_sticky boolean DEFAULT false NOT NULL,
    ADD CONSTRAINT servers_root_placement_check
        CHECK (root_placement = ANY (ARRAY['single', 'random'])
            AND (NOT root_placement_sticky OR root_placement = 'random'));

UPDATE infra.storage_pools AS pools
SET system_disk = true
FROM infra.servers AS servers
WHERE servers.system_pool_id = pools.id;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM infra.servers AS servers
        WHERE (SELECT count(*) FROM infra.storage_pools AS pools
               WHERE pools.server_id = servers.id AND pools.system_disk)
            <> (CASE WHEN servers.system_pool_id IS NULL THEN 0 ELSE 1 END)
    ) THEN
        RAISE EXCEPTION '000013: system pools did not carry over one to one';
    END IF;
END $$;

-- At most one system pool while a server places root disks `single`.
CREATE FUNCTION control.assert_server_root_placement() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  target_server_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'servers' THEN
    target_server_id := NEW.id;
  ELSE
    target_server_id := NEW.server_id;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM infra.servers AS servers
    WHERE servers.id = target_server_id
      AND servers.root_placement = 'single'
      AND (SELECT count(*) FROM infra.storage_pools AS pools
           WHERE pools.server_id = servers.id AND pools.system_disk) > 1
  ) THEN
    RAISE EXCEPTION 'a server placing root disks single has at most one system pool'
      USING ERRCODE = '23514', CONSTRAINT = 'servers_root_placement_single';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER storage_pools_root_placement_single
AFTER INSERT OR UPDATE OF system_disk, server_id ON infra.storage_pools
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION control.assert_server_root_placement();
CREATE CONSTRAINT TRIGGER servers_root_placement_single
AFTER UPDATE OF root_placement ON infra.servers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION control.assert_server_root_placement();

-- The pool's own CHECK now keeps a system pool registered and root-capable.
DROP TRIGGER servers_system_pool_scope ON infra.servers;
DROP FUNCTION control.assert_server_system_pool_scope();

CREATE OR REPLACE FUNCTION control.assert_storage_pool_mutation() RETURNS trigger
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

ALTER TABLE infra.servers DROP COLUMN system_pool_id;
