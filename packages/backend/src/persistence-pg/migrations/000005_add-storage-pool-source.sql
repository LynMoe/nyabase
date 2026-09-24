--
-- Persist Incus storage-pool config.source so the admin card can show
-- host location without a live Incus GET on every list.
--

ALTER TABLE infra.storage_pools
    ADD COLUMN source text;

ALTER TABLE infra.storage_pools
    ADD CONSTRAINT storage_pools_source_check
        CHECK (source IS NULL
            OR (length(btrim(source)) BETWEEN 1 AND 1024
                AND source !~ '[\000\r\n]'));

COMMENT ON COLUMN infra.storage_pools.source IS
  'Last observed Incus config.source (dir mount, VG/device, pool name); null until discover has seen it';
