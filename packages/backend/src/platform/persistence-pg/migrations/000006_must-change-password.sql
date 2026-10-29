--
-- A password someone else chose must be replaced at the next sign-in.
--
-- Set when a user administrator creates the user or resets their password
-- (not for the bootstrap admin, nor an admin resetting their own); cleared
-- when the user changes their own password. The web UI blocks on it.
--

ALTER TABLE iam.users
    ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
