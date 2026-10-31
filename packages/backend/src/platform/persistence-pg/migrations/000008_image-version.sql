--
-- The version an image was published as, from the catalog (`20261027_nb01`):
-- users see its date next to the image name. A version row's created_at is when
-- this platform first pulled it, which can be long after, so it will not do.
--
-- Existing rows have the version only inside the catalog description
-- (`Ubuntu 24.04 v20261027_nb01`). NULL = not from the catalog: no date is shown.
--

ALTER TABLE infra.image_versions ADD COLUMN version text;
ALTER TABLE infra.images ADD COLUMN version text;

UPDATE infra.image_versions
    SET version = substring(description from ' v([0-9]{8}[^ ]*)$');

UPDATE infra.images AS image
    SET version = current_version.version
    FROM infra.image_versions AS current_version
    WHERE current_version.image_id = image.id
      AND current_version.fingerprint = image.fingerprint;
