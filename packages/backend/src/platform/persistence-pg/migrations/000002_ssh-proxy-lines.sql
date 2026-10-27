--
-- SSH proxy lines: the public addresses users reach the same SSH proxy by
-- (a campus network, a region, a relay), in the administrators' order. They
-- replace the ssh.proxyPublicHost / ssh.proxyPublicPort settings; an address
-- already set there becomes the first line. The old settings were barely
-- validated: a value the new table would refuse (a host with spaces, a port
-- in it or over 253 characters, a port that is not 1..65535) is dropped
-- rather than failing the upgrade, and the administrator adds the line.
--

CREATE TABLE interaction.ssh_proxy_lines (
    id uuid NOT NULL,
    name text NOT NULL,
    host text NOT NULL,
    port integer NOT NULL,
    hint text,
    sort_order integer NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ssh_proxy_lines_pkey PRIMARY KEY (id),
    CONSTRAINT ssh_proxy_lines_name_check CHECK (length(btrim(name)) > 0),
    CONSTRAINT ssh_proxy_lines_host_check CHECK (length(host) BETWEEN 1 AND 253),
    CONSTRAINT ssh_proxy_lines_port_check CHECK (port BETWEEN 1 AND 65535),
    CONSTRAINT ssh_proxy_lines_hint_check CHECK (hint IS NULL OR length(btrim(hint)) > 0),
    CONSTRAINT ssh_proxy_lines_sort_order_check CHECK (sort_order >= 0)
);

CREATE UNIQUE INDEX ssh_proxy_lines_name_key ON interaction.ssh_proxy_lines (lower(name));

COMMENT ON TABLE interaction.ssh_proxy_lines IS
  'Public addresses of the SSH proxy; each is an ssh -J tab on every container, the first is the default for the one-time client setup';

INSERT INTO interaction.ssh_proxy_lines (id, name, host, port, sort_order)
SELECT gen_random_uuid(), '默认', old.host, old.port::integer, 0
FROM (
    SELECT lower(btrim("values"->>'ssh.proxyPublicHost')) AS host,
           "values"->>'ssh.proxyPublicPort' AS port
    FROM system.settings
    WHERE jsonb_typeof("values"->'ssh.proxyPublicPort') = 'number'
) AS old
WHERE length(old.host) BETWEEN 1 AND 253
  AND (old.host ~ '^[a-z0-9.-]+$' OR old.host ~ '^[0-9a-f:.]*:[0-9a-f:.]*:[0-9a-f:.]*$')
  AND CASE WHEN old.port ~ '^[1-9][0-9]{0,4}$' THEN old.port::integer <= 65535 ELSE false END;

UPDATE system.settings
SET "values" = "values" - 'ssh.proxyPublicHost' - 'ssh.proxyPublicPort',
    revision = revision + 1,
    updated_at = clock_timestamp()
WHERE "values" ?| ARRAY['ssh.proxyPublicHost', 'ssh.proxyPublicPort'];
