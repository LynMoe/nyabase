--
-- Who really performed an audited action.
--
-- An administrator may act as a plain user (`X-Nyabase-Act-As`): the request
-- runs with that user's permissions and the row's actor is the user. The
-- impersonator columns name the administrator who sent the request (NULL
-- otherwise); name and username are snapshots, like the actor's.
--

ALTER TABLE audit.events
    ADD COLUMN impersonator_id text,
    ADD COLUMN impersonator_name text,
    ADD COLUMN impersonator_username text;

CREATE INDEX audit_events_impersonator_idx
    ON audit.events (impersonator_id, occurred_at DESC, id DESC)
    WHERE impersonator_id IS NOT NULL;
