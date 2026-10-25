--
-- Per-binding HTTP traffic counters reported by the HTTP proxies.
--
-- A proxy reports raw counters that are cumulative since its process started,
-- so each process (proxy instance) has its own row per binding and a binding's
-- totals are the sum over instances. Rows of an instance that has not reported
-- for a day are folded into one 'archived' row per binding, and the instance is
-- marked archived so it is never counted again (its rows already are).
--

CREATE TABLE interaction.http_proxy_counter_instances (
    proxy_instance text NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT http_proxy_counter_instances_pkey PRIMARY KEY (proxy_instance),
    CONSTRAINT http_proxy_counter_instances_key_check
        CHECK (proxy_instance <> 'archived' AND length(proxy_instance) BETWEEN 1 AND 256)
);

CREATE TABLE interaction.http_proxy_binding_counters (
    proxy_instance text NOT NULL,
    binding_id uuid NOT NULL
        REFERENCES interaction.http_proxy_bindings(id) ON DELETE CASCADE,
    requests bigint DEFAULT 0 NOT NULL,
    rx_bytes bigint DEFAULT 0 NOT NULL,
    tx_bytes bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT http_proxy_binding_counters_pkey PRIMARY KEY (proxy_instance, binding_id),
    CONSTRAINT http_proxy_binding_counters_values_check
        CHECK (requests >= 0 AND rx_bytes >= 0 AND tx_bytes >= 0)
);

-- Totals are read per binding.
CREATE INDEX http_proxy_binding_counters_binding_idx
    ON interaction.http_proxy_binding_counters (binding_id);
