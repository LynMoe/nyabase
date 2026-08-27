--
-- Persist observed root-disk usage so the container API can expose shrink floors
-- without a live Incus round-trip on every GET.
--

ALTER TABLE control.containers
    ADD COLUMN root_used_bytes bigint;

ALTER TABLE control.containers
    ADD CONSTRAINT containers_root_used_bytes_check
        CHECK (root_used_bytes IS NULL OR root_used_bytes >= 0);

COMMENT ON COLUMN control.containers.root_used_bytes IS
  'Last observed Incus root disk usage; null until reconcile has seen instance state';
