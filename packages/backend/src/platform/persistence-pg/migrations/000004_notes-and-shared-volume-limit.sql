--
-- Administrator notes and a per-user volume limit on shared backends.
--
-- iam.users.note is a free-text note the user administrators keep about a
-- user; the user never sees it. infra.shared_backends.note is shown to users
-- when they create a shared volume (what the storage is for, how it is backed
-- up). infra.shared_backends.max_volumes_per_user caps how many shared
-- volumes one user may own on the backend; NULL = no cap. Existing volumes
-- over a newly set cap are kept: the cap only refuses new ones.
--

ALTER TABLE iam.users
    ADD COLUMN note text,
    ADD CONSTRAINT users_note_check
        CHECK (note IS NULL OR (length(btrim(note)) > 0 AND length(note) <= 1000));

ALTER TABLE infra.shared_backends
    ADD COLUMN note text,
    ADD COLUMN max_volumes_per_user integer,
    ADD CONSTRAINT shared_backends_note_check
        CHECK (note IS NULL OR (length(btrim(note)) > 0 AND length(note) <= 500)),
    ADD CONSTRAINT shared_backends_max_volumes_per_user_check
        CHECK (max_volumes_per_user IS NULL OR max_volumes_per_user > 0);
