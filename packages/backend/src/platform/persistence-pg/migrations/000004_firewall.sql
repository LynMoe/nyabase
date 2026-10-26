--
-- Guest egress firewall rules.
--
-- Admin-owned rules, each associated with any number of servers. On a server
-- the rules associated with it apply in priority order (smaller first, the
-- first match decides, no match accepts); the Backend renders them into one
-- document per server and pushes it to that server's agent. CIDRs and ports
-- are stored in canonical form (common/src/protocol/firewall.ts).
--

CREATE TABLE infra.firewall_rules (
    id uuid NOT NULL,
    name text NOT NULL,
    description text DEFAULT '' NOT NULL,
    priority integer NOT NULL,
    action text NOT NULL,
    protocol text NOT NULL,
    ports jsonb DEFAULT '[]'::jsonb NOT NULL,
    cidrs jsonb NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT firewall_rules_pkey PRIMARY KEY (id),
    CONSTRAINT firewall_rules_name_key UNIQUE (name),
    CONSTRAINT firewall_rules_priority_key UNIQUE (priority),
    CONSTRAINT firewall_rules_name_check CHECK (length(btrim(name)) > 0),
    CONSTRAINT firewall_rules_priority_check CHECK (priority BETWEEN 1 AND 1000000),
    CONSTRAINT firewall_rules_action_check CHECK (action = ANY (ARRAY['accept', 'drop', 'reject'])),
    CONSTRAINT firewall_rules_protocol_check CHECK (protocol = ANY (ARRAY['all', 'tcp', 'udp'])),
    CONSTRAINT firewall_rules_ports_check CHECK (jsonb_typeof(ports) = 'array'),
    CONSTRAINT firewall_rules_protocol_ports_check CHECK (protocol <> 'all' OR ports = '[]'::jsonb),
    CONSTRAINT firewall_rules_cidrs_check
        CHECK (jsonb_typeof(cidrs) = 'array' AND jsonb_array_length(cidrs) > 0),
    CONSTRAINT firewall_rules_revision_check CHECK (revision > 0)
);

CREATE TABLE infra.firewall_rule_servers (
    rule_id uuid NOT NULL REFERENCES infra.firewall_rules(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES infra.servers(id) ON DELETE CASCADE,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT firewall_rule_servers_pkey PRIMARY KEY (rule_id, server_id)
);

-- Documents are built per server.
CREATE INDEX firewall_rule_servers_server_idx ON infra.firewall_rule_servers (server_id, rule_id);

CREATE TRIGGER firewall_rules_touch_updated_at
BEFORE UPDATE ON infra.firewall_rules
FOR EACH ROW EXECUTE FUNCTION infra.touch_updated_at();
