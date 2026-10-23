--
-- A shrink is written to the desired size when it is accepted, but Incus only
-- gives the space back once the reconciler applies (and verifies) it; until
-- then the volume or root disk may still hold any larger size it had since its
-- last verification. The reservation keeps the largest such size so quota and
-- capacity count greatest(size, reservation) and a shrink the reconciler has
-- to revert never pushes its owner past a grant or a pool past its capacity.
-- NULL means nothing larger than the desired size is outstanding.
--

ALTER TABLE control.volumes
    ADD COLUMN shrink_reserved_bytes bigint,
    ADD CONSTRAINT volumes_shrink_reserved_bytes_check
        CHECK (shrink_reserved_bytes IS NULL OR shrink_reserved_bytes > 0);

COMMENT ON COLUMN control.volumes.shrink_reserved_bytes IS
  'Largest size Incus may still hold until a requested shrink is verified; committed bytes are greatest(size_bytes, shrink_reserved_bytes)';

ALTER TABLE control.containers
    ADD COLUMN root_shrink_reserved_bytes bigint,
    ADD CONSTRAINT containers_root_shrink_reserved_bytes_check
        CHECK (root_shrink_reserved_bytes IS NULL OR root_shrink_reserved_bytes > 0);

COMMENT ON COLUMN control.containers.root_shrink_reserved_bytes IS
  'Largest root size Incus may still hold until a requested root shrink is verified and applied';
