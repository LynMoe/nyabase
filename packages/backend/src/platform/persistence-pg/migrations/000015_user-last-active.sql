--
-- When a user last used the web panel, for the administrators' user list. A
-- password login or a session refresh counts: the panel refreshes its access
-- token on load and whenever it has expired, so the resolution is about
-- `auth.jwtExpiresIn`. Being acted as by an admin does not count (the admin's
-- own session refreshes), nor does SSH.
--
-- Backfilled from the last login and the sessions still on record: NULL means
-- no activity is known, not that there never was any.
--

ALTER TABLE iam.users ADD COLUMN last_active_at timestamp with time zone;

UPDATE iam.users AS users
    SET last_active_at = greatest(
        users.last_login_at,
        (
            SELECT max(coalesce(token.rotated_at, token.created_at))
            FROM iam.refresh_tokens AS token
            WHERE token.user_id = users.id
        )
    )
    WHERE users.last_login_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM iam.refresh_tokens AS token WHERE token.user_id = users.id);
