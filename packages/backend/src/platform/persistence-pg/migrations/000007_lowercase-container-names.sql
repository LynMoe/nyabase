--
-- Container names are lower case: they read as host names (`ssh <name>.<suffix>`).
--
-- SSH routing and the host certificate principals already lower-cased them, so
-- converting existing names breaks no connection. A guest's prompt label follows
-- at the next full scan.
--

UPDATE control.containers SET name = lower(name) WHERE name <> lower(name);

ALTER TABLE control.containers
    DROP CONSTRAINT containers_name_check,
    ADD CONSTRAINT containers_name_check
        CHECK (length(name) BETWEEN 1 AND 63 AND name ~ '^[a-z0-9][a-z0-9-]*$');
