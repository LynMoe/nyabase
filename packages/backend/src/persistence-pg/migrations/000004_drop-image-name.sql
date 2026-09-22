--
-- Catalog images are identified by their source alias.
-- A separate display name is not part of the image source.
--

DROP INDEX infra.images_catalog_idx;

ALTER TABLE infra.images DROP CONSTRAINT images_name_key;
ALTER TABLE infra.images DROP CONSTRAINT images_name_check;
ALTER TABLE infra.images DROP COLUMN name;

CREATE INDEX images_catalog_idx
    ON infra.images (is_active, deleting, alias, id);
