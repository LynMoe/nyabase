--
-- Where a shared backend's volumes mount by default (`/meowfs`): the mount form
-- fills it in when one of them is chosen, and the user can still edit it. It is
-- only a suggestion: existing mounts stay where they are. NULL = the usual `/data`.
--

ALTER TABLE infra.shared_backends
    ADD COLUMN default_mount_path text,
    ADD CONSTRAINT shared_backends_default_mount_path_check
        CHECK (default_mount_path IS NULL OR (length(default_mount_path) BETWEEN 2 AND 4096 AND default_mount_path LIKE '/%'));
