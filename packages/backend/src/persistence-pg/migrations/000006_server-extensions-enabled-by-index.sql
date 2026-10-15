--
-- Cover the iam.users foreign key so deleting a user does not scan every
-- server extension row for ON DELETE SET NULL.
--

CREATE INDEX server_extensions_enabled_by_idx
    ON infra.server_extensions (enabled_by);
