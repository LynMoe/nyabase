--
-- Container names are lower case: they read as host names (`ssh <name>.<suffix>`).
--
-- SSH routing and the host certificate principals already lower-cased them, so
-- the converted name still reaches the container. A guest's prompt label follows
-- at the next full scan.
--
-- Names were unique per server only case-sensitively, so two users could hold
-- `Foo` and `foo` on one server: whichever is converted into the other gets its
-- id appended rather than failing the migration.
--

UPDATE control.containers AS container
    SET name = left(lower(container.name), 50) || CASE
        WHEN EXISTS (
            SELECT 1 FROM control.containers AS other
            WHERE other.server_id = container.server_id
              AND other.id <> container.id
              AND lower(other.name) = lower(container.name)
              AND (other.name = lower(other.name) OR other.id < container.id)
        ) THEN '-' || right(container.id::text, 12)
        ELSE ''
    END
    WHERE container.name <> lower(container.name);

ALTER TABLE control.containers
    DROP CONSTRAINT containers_name_check,
    ADD CONSTRAINT containers_name_check
        CHECK (length(name) BETWEEN 1 AND 63 AND name ~ '^[a-z0-9][a-z0-9-]*$');
