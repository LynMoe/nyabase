-- Every fingerprint an image has been pulled at. A repull moves the image (and
-- new containers) to the new fingerprint but leaves older copies on the servers,
-- so existing containers keep the version they were created from. An operator
-- deletes a version once no container uses it: the row is kept as a tombstone
-- (deleted_at) and each server's full scan removes the copies nothing needs.
CREATE TABLE infra.image_versions (
    image_id uuid NOT NULL REFERENCES infra.images(id) ON DELETE CASCADE,
    fingerprint text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT image_versions_pkey PRIMARY KEY (image_id, fingerprint),
    CONSTRAINT image_versions_fingerprint_check CHECK (fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX image_versions_fingerprint_idx ON infra.image_versions (fingerprint);

-- The image copies nyabase pulled onto (or adopted on) each server: the full
-- scan only ever removes copies listed here, so images the host's owner keeps
-- in the same Incus are never touched. Kept past the image row, so copies of
-- a deleted image are still found and removed. recorded_at is refreshed by
-- every ensure that holds the copy.
CREATE TABLE infra.image_copies (
    server_id uuid NOT NULL REFERENCES infra.servers(id) ON DELETE CASCADE,
    fingerprint text NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT image_copies_pkey PRIMARY KEY (server_id, fingerprint),
    CONSTRAINT image_copies_fingerprint_check CHECK (fingerprint ~ '^[0-9a-f]{64}$')
);

-- The current fingerprint keeps its description; versions only containers or
-- server copies still remember start without one.
INSERT INTO infra.image_versions (image_id, fingerprint, description)
SELECT id, fingerprint, description
FROM infra.images
WHERE fingerprint IS NOT NULL;

INSERT INTO infra.image_versions (image_id, fingerprint)
SELECT DISTINCT image_id, image_fingerprint
FROM control.containers
ON CONFLICT DO NOTHING;

INSERT INTO infra.image_versions (image_id, fingerprint)
SELECT DISTINCT image_id, managed_fingerprint
FROM infra.image_server_assignments
WHERE managed_fingerprint IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO infra.image_copies (server_id, fingerprint)
SELECT server_id, managed_fingerprint FROM infra.image_server_assignments WHERE managed_fingerprint IS NOT NULL
UNION
SELECT server_id, observed_fingerprint FROM infra.image_server_assignments WHERE observed_fingerprint IS NOT NULL
UNION
SELECT server_id, image_fingerprint FROM control.containers
ON CONFLICT DO NOTHING;
