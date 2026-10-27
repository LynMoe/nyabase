--
-- SSH proxy lines: the public addresses users reach the same SSH proxy by
-- (a campus network, a region, a relay), in the administrators' order. They
-- replace the ssh.proxyPublicHost / ssh.proxyPublicPort settings; an address
-- already set there becomes the first line.
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
SELECT gen_random_uuid(),
       '默认',
       lower(btrim("values"->>'ssh.proxyPublicHost')),
       ("values"->>'ssh.proxyPublicPort')::integer,
       0
FROM system.settings
WHERE btrim(coalesce("values"->>'ssh.proxyPublicHost', '')) <> ''
  AND jsonb_typeof("values"->'ssh.proxyPublicPort') = 'number';

UPDATE system.settings
SET "values" = "values" - 'ssh.proxyPublicHost' - 'ssh.proxyPublicPort',
    revision = revision + 1,
    updated_at = clock_timestamp()
WHERE "values" ?| ARRAY['ssh.proxyPublicHost', 'ssh.proxyPublicPort'];
