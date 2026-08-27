const SERVER_NETWORK_FIELDS = [
  ['parentInterface', 'E2E_INCUS_PARENT_INTERFACE'],
  ['dnsServers', 'E2E_INCUS_DNS_SERVERS'],
];
const INCUS_SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function blocked(message) {
  throw new Error(`BLOCKED: ${message}`);
}

export function validateIncusServerName(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 128
    || value.trim() !== value
    || !INCUS_SERVER_NAME_RE.test(value)
  ) {
    blocked('Incus /1.0 environment.server_name is missing or invalid');
  }
  return value;
}

export async function resolveIncusServerName(incusRequest) {
  if (typeof incusRequest !== 'function') {
    blocked('Incus bootstrap request client is unavailable');
  }
  const response = await incusRequest('/1.0');
  return validateIncusServerName(response?.metadata?.environment?.server_name);
}

function listInput(env, name) {
  const value = env[name]?.trim();
  if (!value) return [];
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => !entry)) {
    blocked(`${name} must be a comma-separated list without empty entries`);
  }
  return entries;
}

function defaultServerSlug(runId) {
  const full = `e2e-${runId}`;
  if (full.length <= 64) return full;
  return `e2e-${runId.slice(0, 43)}-${runId.slice(-16)}`;
}

export function createRoutedNetworkConfig(env = process.env) {
  const required = [
    'E2E_INCUS_ROUTED_SUBNET',
    'E2E_INCUS_ROUTED_GATEWAY',
  ];
  for (const name of required) {
    if (!env[name]?.trim()) blocked(`missing ${name}`);
  }
  const reserved = new Set(listInput(env, 'E2E_INCUS_LAN_RESERVED_IPS'));
  for (const name of [
    'E2E_INCUS_ROUTED_GATEWAY',
    'E2E_INCUS_ROUTED_ADDRESS',
    'E2E_INCUS_SPOOF_ADDRESS',
    'E2E_INCUS_PROBE_ADDRESS',
  ]) {
    const value = env[name]?.trim();
    if (value) reserved.add(value);
  }
  return {
    cidr: env.E2E_INCUS_ROUTED_SUBNET.trim(),
    allocationCidr: (env.E2E_INCUS_ALLOCATION_CIDR?.trim() || env.E2E_INCUS_ROUTED_SUBNET.trim()),
    gateway: env.E2E_INCUS_ROUTED_GATEWAY.trim(),
    reservedIps: [...reserved].sort(),
  };
}

export function createServerRegistrationConfig(env = process.env, runId, actualServerName) {
  if (!runId) blocked('run id is required to derive the E2E server identity');
  const required = [
    'E2E_INCUS_API_ENDPOINT',
    'E2E_INCUS_PARENT_INTERFACE',
    'E2E_INCUS_ROUTED_SUBNET',
    'E2E_INCUS_ROUTED_GATEWAY',
  ];
  for (const name of required) {
    if (!env[name]?.trim()) blocked(`missing ${name}`);
  }

  const name = validateIncusServerName(actualServerName);
  const slug = env.E2E_INCUS_SERVER_SLUG?.trim() || defaultServerSlug(runId);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug) || slug.length > 64) {
    blocked('E2E_INCUS_SERVER_SLUG is not a valid server slug');
  }

  return {
    name,
    slug,
    apiEndpoint: env.E2E_INCUS_API_ENDPOINT.trim(),
    parentInterface: env.E2E_INCUS_PARENT_INTERFACE.trim(),
    dnsServers: listInput(env, 'E2E_INCUS_DNS_SERVERS'),
  };
}

function sameArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

export function assertServerRegistrationMatches(server, registration) {
  if (!server?.id) blocked('server registration response did not include a server id');
  if (server.name !== registration.name) {
    blocked('registered server name does not match the validated Incus identity');
  }
  if (server.slug !== registration.slug) {
    blocked('registered server slug does not match the run-scoped identity');
  }
  if (server.apiEndpoint !== registration.apiEndpoint) {
    blocked('registered server endpoint does not match E2E_INCUS_API_ENDPOINT');
  }

  const mismatches = SERVER_NETWORK_FIELDS.flatMap(([field]) => {
    const expected = registration[field];
    const matches = Array.isArray(expected)
      ? sameArray(server[field], expected)
      : server[field] === expected;
    return matches ? [] : [field];
  });
  if (mismatches.length > 0) {
    blocked(
      `registered server routed-network fields do not match the configured inputs: ${mismatches.join(', ')}`,
    );
  }
  return server;
}

function endpointMatches(servers, endpoint) {
  return servers.filter((server) => server.apiEndpoint === endpoint);
}

function nameMatches(servers, name) {
  return servers.filter((server) => server.name === name);
}

function inheritedOwnership(server, priorServer, registration) {
  return Boolean(
    priorServer?.createdByRun === true
      && priorServer.id === server.id
      && priorServer.endpoint === registration.apiEndpoint,
  );
}

export async function ensureServerRegistration({
  listServers,
  createServer,
  registration,
  requestedServerId,
  priorServer,
}) {
  const list = async () => {
    const servers = await listServers();
    if (!Array.isArray(servers)) blocked('admin server list response was not an array');
    return servers;
  };

  const requestedId = requestedServerId?.trim() || undefined;
  let servers = await list();
  let endpointServers = endpointMatches(servers, registration.apiEndpoint);
  const nameServers = nameMatches(servers, registration.name);
  const idServer = requestedId
    ? servers.find((server) => server.id === requestedId)
    : undefined;

  if (nameServers.some((server) => server.apiEndpoint !== registration.apiEndpoint)) {
    blocked('E2E_INCUS server name belongs to a different API endpoint');
  }

  if (idServer) {
    if (idServer.apiEndpoint !== registration.apiEndpoint) {
      blocked('E2E_INCUS_SERVER_ID points to a server with a different API endpoint');
    }
    if (endpointServers.some((server) => server.id !== idServer.id)) {
      blocked('E2E_INCUS_SERVER_ID conflicts with another server using E2E_INCUS_API_ENDPOINT');
    }
    return {
      server: assertServerRegistrationMatches(idServer, registration),
      createdByRun: inheritedOwnership(idServer, priorServer, registration),
    };
  }

  if (requestedId && endpointServers.length > 0) {
    if (
      endpointServers.length === 1
      && inheritedOwnership(endpointServers[0], priorServer, registration)
    ) {
      return {
        server: assertServerRegistrationMatches(endpointServers[0], registration),
        createdByRun: true,
      };
    }
    blocked('E2E_INCUS_SERVER_ID is not registered but E2E_INCUS_API_ENDPOINT belongs to another server');
  }

  if (!requestedId) {
    if (endpointServers.length > 1) {
      blocked('multiple registered servers match E2E_INCUS_API_ENDPOINT');
    }
    if (endpointServers.length === 1) {
      const server = assertServerRegistrationMatches(endpointServers[0], registration);
      return {
        server,
        createdByRun: inheritedOwnership(server, priorServer, registration),
      };
    }
  }

  try {
    const server = assertServerRegistrationMatches(
      await createServer(registration),
      registration,
    );
    return { server, createdByRun: true };
  } catch (error) {
    // A request can succeed remotely while its response is lost. Re-list before
    // surfacing a conflict so a retry cannot create a second registration.
    try {
      servers = await list();
      endpointServers = endpointMatches(servers, registration.apiEndpoint);
    } catch {
      throw error;
    }
    if (endpointServers.length === 1) {
      const server = endpointServers[0];
      if (requestedId && server.id !== requestedId) {
        blocked('server registration response conflicts with E2E_INCUS_SERVER_ID');
      }
      return {
        server: assertServerRegistrationMatches(server, registration),
        createdByRun: true,
      };
    }
    if (error?.statusCode === 409 || endpointServers.length > 1) {
      blocked('server registration conflicted with an existing server identity');
    }
    throw error;
  }
}

function sameStringArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

export async function ensureIpPoolForServer({
  listPools,
  createPool,
  patchPool,
  serverId,
  serverSlug,
  network,
}) {
  if (!serverId) blocked('server id is required to bind an IP pool');
  if (!network?.cidr || !network?.gateway) {
    blocked('LAN CIDR and gateway are required for IP pool binding');
  }
  const pools = await listPools();
  if (!Array.isArray(pools)) blocked('admin IP pool list response was not an array');

  let pool = pools.find((entry) => entry.cidr === network.cidr);
  if (!pool) {
    pool = await createPool({
      name: `e2e-${serverSlug}`.slice(0, 128),
      cidr: network.cidr,
      allocationCidr: network.allocationCidr || network.cidr,
      gateway: network.gateway,
      reservedIps: network.reservedIps ?? [],
      serverIds: [serverId],
    });
  } else {
    if (pool.gateway !== network.gateway) {
      blocked(`existing IP pool ${pool.id} gateway does not match E2E_INCUS_ROUTED_GATEWAY`);
    }
    const desiredAllocation = network.allocationCidr || network.cidr;
    const needsAllocationUpdate = pool.allocationCidr !== desiredAllocation;
    const needsReservedUpdate = !sameStringArray(pool.reservedIps ?? [], network.reservedIps ?? []);
    const needsServerBind = !(pool.serverIds ?? []).includes(serverId);
    if (needsAllocationUpdate || needsReservedUpdate || needsServerBind) {
      pool = await patchPool(pool.id, {
        expectedRevision: pool.revision,
        ...(needsAllocationUpdate ? { allocationCidr: desiredAllocation } : {}),
        ...(needsReservedUpdate ? { reservedIps: network.reservedIps ?? [] } : {}),
        ...(needsServerBind
          ? { serverIds: [...new Set([...(pool.serverIds ?? []), serverId])] }
          : {}),
      });
    }
  }

  if (!pool?.id) blocked('IP pool ensure did not return a pool id');
  if (!(pool.serverIds ?? []).includes(serverId)) {
    blocked('IP pool is not bound to the registered E2E server');
  }
  return pool;
}
