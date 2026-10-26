--
-- SSH proxy connection history.
--
-- A proxy reports every authenticated connection, and each channel it opens
-- or refuses, as a full record when it opens and again when it closes. Rows
-- are keyed by the proxy instance (one per proxy process) and the sequence
-- numbers that instance assigned, so records are upserted in any order and
-- a record sent twice changes nothing. Users, servers and containers are
-- kept by id and by their names at the time, without foreign keys: the
-- history outlives them.
--
-- Unauthenticated connections are only counted, per proxy window, address
-- and reason. Old detail rows are folded into per-day usage and deleted.
--

CREATE TABLE interaction.ssh_proxy_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    proxy_instance text NOT NULL,
    connection_seq bigint NOT NULL,
    proxy_id text NOT NULL,
    peer text NOT NULL,
    peer_ip text NOT NULL,
    client_version text,
    login text NOT NULL,
    user_id uuid NOT NULL,
    username text NOT NULL,
    key_fingerprint text NOT NULL,
    key_algorithm text NOT NULL,
    pinned_server_id uuid,
    pinned_server_slug text,
    pinned_container_id uuid,
    pinned_container_name text,
    connected_at timestamp with time zone NOT NULL,
    authenticated_at timestamp with time zone NOT NULL,
    closed_at timestamp with time zone,
    close_reason text,
    -- Last time the proxy reported the connection; a connection whose proxy
    -- went away is closed as 'lost' at this time.
    last_seen_at timestamp with time zone NOT NULL,
    bytes_from_client bigint DEFAULT 0 NOT NULL,
    bytes_to_client bigint DEFAULT 0 NOT NULL,
    channels_opened bigint DEFAULT 0 NOT NULL,
    channels_rejected bigint DEFAULT 0 NOT NULL,
    rejected_requests jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT ssh_proxy_connections_pkey PRIMARY KEY (id),
    CONSTRAINT ssh_proxy_connections_seq_key UNIQUE (proxy_instance, connection_seq),
    CONSTRAINT ssh_proxy_connections_closed_check
        CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
    CONSTRAINT ssh_proxy_connections_values_check
        CHECK (bytes_from_client >= 0 AND bytes_to_client >= 0
            AND channels_opened >= 0 AND channels_rejected >= 0)
);

CREATE INDEX ssh_proxy_connections_connected_idx
    ON interaction.ssh_proxy_connections (connected_at DESC, id DESC);
CREATE INDEX ssh_proxy_connections_user_idx
    ON interaction.ssh_proxy_connections (user_id, connected_at DESC, id DESC);
CREATE INDEX ssh_proxy_connections_open_idx
    ON interaction.ssh_proxy_connections (proxy_instance, last_seen_at)
    WHERE closed_at IS NULL;

CREATE TABLE interaction.ssh_proxy_channels (
    proxy_instance text NOT NULL,
    connection_seq bigint NOT NULL,
    channel_seq bigint NOT NULL,
    target_host text NOT NULL,
    target_port bigint NOT NULL,
    originator text NOT NULL,
    server_id uuid,
    server_slug text,
    container_id uuid,
    container_name text,
    instance_name text,
    routed_ip text,
    -- 'opened', or why the channel was refused.
    result text NOT NULL,
    opened_at timestamp with time zone NOT NULL,
    closed_at timestamp with time zone,
    close_reason text,
    bytes_from_client bigint DEFAULT 0 NOT NULL,
    bytes_to_client bigint DEFAULT 0 NOT NULL,
    CONSTRAINT ssh_proxy_channels_pkey PRIMARY KEY (proxy_instance, connection_seq, channel_seq),
    CONSTRAINT ssh_proxy_channels_values_check
        CHECK (bytes_from_client >= 0 AND bytes_to_client >= 0)
);

CREATE INDEX ssh_proxy_channels_container_idx
    ON interaction.ssh_proxy_channels (container_id, opened_at DESC)
    WHERE container_id IS NOT NULL;
CREATE INDEX ssh_proxy_channels_server_idx
    ON interaction.ssh_proxy_channels (server_id, opened_at DESC)
    WHERE server_id IS NOT NULL;
CREATE INDEX ssh_proxy_channels_opened_idx
    ON interaction.ssh_proxy_channels (opened_at);

CREATE TABLE interaction.ssh_proxy_refusals (
    proxy_instance text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    -- '' counts the addresses beyond the proxy's per-window bound.
    peer_ip text NOT NULL,
    reason text NOT NULL,
    window_end timestamp with time zone NOT NULL,
    count bigint NOT NULL,
    CONSTRAINT ssh_proxy_refusals_pkey PRIMARY KEY (proxy_instance, window_start, peer_ip, reason),
    CONSTRAINT ssh_proxy_refusals_count_check CHECK (count > 0)
);

CREATE INDEX ssh_proxy_refusals_window_idx
    ON interaction.ssh_proxy_refusals (window_start);

-- Detail rows past the retention, summed per UTC day. A row with a NULL
-- container_id holds a user's connections and their bytes; the others hold
-- the channels to one container and their bytes.
CREATE TABLE interaction.ssh_proxy_daily_usage (
    day date NOT NULL,
    user_id uuid NOT NULL,
    username text NOT NULL,
    container_id uuid,
    container_name text,
    server_id uuid,
    server_slug text,
    connections bigint DEFAULT 0 NOT NULL,
    channels bigint DEFAULT 0 NOT NULL,
    bytes_from_client bigint DEFAULT 0 NOT NULL,
    bytes_to_client bigint DEFAULT 0 NOT NULL,
    CONSTRAINT ssh_proxy_daily_usage_key UNIQUE NULLS NOT DISTINCT (day, user_id, container_id)
);

CREATE INDEX ssh_proxy_daily_usage_day_idx
    ON interaction.ssh_proxy_daily_usage (day);
