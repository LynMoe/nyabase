--
-- When a user last signed in with their password, for the administrators' user
-- list. Refreshing a session and being acted as by an admin do not count.
--
-- Backfilled from the audit log, which has a retention period: NULL means no
-- login is known, not that there never was one.
--

ALTER TABLE iam.users ADD COLUMN last_login_at timestamp with time zone;

UPDATE iam.users AS users
    SET last_login_at = logins.last_login_at
    FROM (
        SELECT actor_id, max(occurred_at) AS last_login_at
        FROM audit.events
        WHERE action = 'user.login' AND actor_id IS NOT NULL
        GROUP BY actor_id
    ) AS logins
    WHERE logins.actor_id = users.id::text;
