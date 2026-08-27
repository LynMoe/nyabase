import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createServerRegistrationConfig,
  ensureServerRegistration,
  resolveIncusServerName,
} from './server-registration.mjs';
import {
  readTlsOptions,
  removeRunOwnedServer,
  shouldCleanupRunAssignment,
  shouldDeleteRunImage,
  shouldDeleteRunServer,
} from './cleanup.mjs';
import { parseConnectIntentId } from './connect-intent.mjs';
import {
  discoverStoragePools,
  registerStoragePools,
  validateRegisteredStoragePoolDto,
  validateStoragePoolDtos,
} from './storage-pool-discovery.mjs';
import {
  buildImageRegistrationConfig,
  ensureImageRegistration,
} from './image-registration.mjs';

const runId = '20260807-abcdef';
const actualIncusServerName = 'incus-control-plane';

function storagePoolDto(overrides = {}) {
  return {
    id: 'pool-1',
    serverId: 'server-1',
    incusName: 'default',
    displayName: null,
    driver: 'dir',
    resizeFamily: 'quota_online',
    rootDiskCapable: true,
    shareable: false,
    blockFilesystem: null,
    sharedBackendId: null,
    totalBytes: 100,
    usedBytes: 10,
    quotaEffective: true,
    registered: false,
    capability: {
      growOnline: true,
      shrinkOnline: true,
      shrinkRequiresStop: false,
      shrinkNever: false,
      enforceUsageFloor: true,
    },
    lastObservedAt: null,
    revision: 1,
    ...overrides,
  };
}

function lvmStoragePoolDto(overrides = {}) {
  return storagePoolDto({
    id: 'pool-2',
    incusName: 'lvm-pool',
    driver: 'lvm',
    resizeFamily: 'block_backed',
    quotaEffective: null,
    capability: {
      growOnline: true,
      shrinkOnline: false,
      shrinkRequiresStop: true,
      shrinkNever: false,
      enforceUsageFloor: true,
    },
    ...overrides,
  });
}

function imageDto(overrides = {}) {
  return {
    id: 'image-1',
    name: `e2e-${runId}-sshd`,
    alias: 'nyabase-e2e-sshd-no-dhcp-abcdef',
    fingerprint: null,
    description: null,
    loginUser: 'root',
    minRootSizeBytes: null,
    networkManagedExternally: true,
    isActive: true,
    deleting: false,
    cleanupGeneration: 0,
    revision: 1,
    createdAt: '2026-08-07T12:00:00.000Z',
    updatedAt: '2026-08-07T12:00:00.000Z',
    assignments: [],
    ...overrides,
  };
}

function imageRegistrationEnv(overrides = {}) {
  return {
    E2E_INCUS_IMAGE_ALIAS: 'nyabase-e2e-sshd-no-dhcp-abcdef',
    E2E_SSH_USER: 'root',
    ...overrides,
  };
}

test('server connect parsing uses the canonical intentId field', () => {
  const seedSource = readFileSync(join(import.meta.dirname, 'seed.mjs'), 'utf8');
  assert.match(seedSource, /const connectIntentId = parseConnectIntentId\(connectResult\);/);
  assert.match(seedSource, /waitForIntent\(token, connectIntentId, 'server connect'\)/);
  assert.doesNotMatch(seedSource, /connectResult(?:\?\.|\.)id/);
  assert.equal(parseConnectIntentId({ intentId: 'intent-1', id: 'legacy-id' }), 'intent-1');
});

test('server connect parsing rejects missing or malformed intent IDs', () => {
  for (const response of [
    undefined,
    null,
    {},
    { id: 'legacy-id' },
    { intentId: '' },
    { intentId: ' ' },
    { intentId: 42 },
    { intentId: 'invalid intent id' },
    { intentId: `x${'a'.repeat(128)}` },
  ]) {
    assert.throws(
      () => parseConnectIntentId(response),
      /BLOCKED: server connect response did not include a valid intent id/,
    );
  }
});

test('image registration posts the configured alias and SSH user with admin auth', async () => {
  const calls = [];
  const config = buildImageRegistrationConfig(runId, imageRegistrationEnv());
  const result = await ensureImageRegistration({
    listImages: async (token) => {
      calls.push({ method: 'GET', token });
      return [];
    },
    createImage: async (body, token) => {
      calls.push({ method: 'POST', token, body });
      return imageDto(body);
    },
    token: 'admin-token',
    runId,
    env: imageRegistrationEnv(),
  });

  assert.deepEqual(calls, [
    { method: 'GET', token: 'admin-token' },
    {
      method: 'POST',
      token: 'admin-token',
      body: config,
    },
  ]);
  assert.equal(result.createdByRun, true);
  assert.equal(result.image.alias, config.alias);
});

test('image registration reuses a compatible image and inherits run ownership on rerun', async () => {
  const existing = imageDto();
  let createCalls = 0;
  const result = await ensureImageRegistration({
    listImages: async () => [existing],
    createImage: async () => {
      createCalls += 1;
      throw new Error('must not create a duplicate image');
    },
    token: 'admin-token',
    runId,
    env: imageRegistrationEnv(),
    priorImage: {
      id: existing.id,
      alias: existing.alias,
      createdByRun: true,
    },
  });

  assert.equal(result.image.id, existing.id);
  assert.equal(result.createdByRun, true);
  assert.equal(createCalls, 0);
});

test('image registration fails closed for an incompatible existing alias', async () => {
  let createCalls = 0;
  await assert.rejects(
    () => ensureImageRegistration({
      listImages: async () => [imageDto({ loginUser: 'ubuntu' })],
      createImage: async () => {
        createCalls += 1;
        return imageDto();
      },
      token: 'admin-token',
      runId,
      env: imageRegistrationEnv(),
    }),
    /BLOCKED: configured image alias is registered with incompatible configuration/,
  );
  assert.equal(createCalls, 0);
});

test('image registration rejects missing or malformed create responses', async () => {
  for (const response of [undefined, null, {}, imageDto({ alias: 'wrong-alias' })]) {
    await assert.rejects(
      () => ensureImageRegistration({
        listImages: async () => [],
        createImage: async () => response,
        token: 'admin-token',
        runId,
        env: imageRegistrationEnv(),
      }),
      /BLOCKED: image registration response/,
    );
  }
});

test('image registration fails closed on a create conflict without exposing response data', async () => {
  const conflict = new Error('duplicate image secret response');
  conflict.statusCode = 409;
  conflict.responseBody = { message: 'secret response body' };
  await assert.rejects(
    () => ensureImageRegistration({
      listImages: async () => [],
      createImage: async () => {
        throw conflict;
      },
      token: 'admin-token',
      runId,
      env: imageRegistrationEnv(),
    }),
    (error) => {
      assert.equal(error.message, 'BLOCKED: image registration conflicted with an existing image');
      assert.doesNotMatch(error.message, /secret/);
      return true;
    },
  );
});

test('seed registers the image after online setup and before Incus fingerprint assignment', () => {
  const seedSource = readFileSync(join(import.meta.dirname, 'seed.mjs'), 'utf8');
  const registrationSource = readFileSync(
    join(import.meta.dirname, 'image-registration.mjs'),
    'utf8',
  );
  const onlineCheck = seedSource.indexOf("if (currentServer.status !== 'online')");
  const registration = seedSource.indexOf(
    'const imageRegistration = await ensureImageRegistration({',
  );
  const post = seedSource.indexOf("method: 'POST'", registration);
  const fingerprintProbe = seedSource.indexOf('let privateImageInfo;', registration);
  const fingerprintFixture = seedSource.indexOf('UPDATE infra.images', registration);
  const assignment = seedSource.indexOf('const assignmentResult = await ensureAssignment(', registration);

  assert.ok(onlineCheck >= 0 && onlineCheck < registration);
  assert.ok(registration < post && post < fingerprintProbe);
  assert.ok(fingerprintProbe < fingerprintFixture && fingerprintFixture < assignment);
  assert.match(seedSource, /token: authToken,\s*body,\s*\n\s*\}\),/);
  assert.match(registrationSource, /E2E_INCUS_IMAGE_ALIAS/);
  assert.match(registrationSource, /E2E_SSH_USER/);
  assert.match(registrationSource, /networkManagedExternally: true/);
});

test('seed discovers and registers storage pools before selecting the system pool', () => {
  const seedSource = readFileSync(join(import.meta.dirname, 'seed.mjs'), 'utf8');
  const onlineCheck = seedSource.indexOf("if (currentServer.status !== 'online')");
  const discovery = seedSource.indexOf(
    'await discoverStoragePools(jsonRequest, server.id, token);',
  );
  const persistedListing = seedSource.indexOf('const pools = validateStoragePoolDtos(');
  const selection = seedSource.indexOf('const dir = pools.find(');
  const registration = seedSource.indexOf(
    'await registerStoragePools(jsonRequest, server.id, token, [dir, lvm]);',
  );
  const registeredListing = seedSource.indexOf(
    'const registeredPools = validateStoragePoolDtos(',
  );
  const systemPoolFixture = seedSource.indexOf('SET system_pool_id =');

  assert.ok(onlineCheck >= 0 && onlineCheck < discovery);
  assert.ok(
    discovery < persistedListing
      && persistedListing < selection
      && selection < registration
      && registration < registeredListing
      && registeredListing < systemPoolFixture,
  );
});

test('storage-pool discovery uses the authenticated public admin endpoint', async () => {
  const calls = [];
  const result = await discoverStoragePools(
    async (path, options) => {
      calls.push({ path, ...options });
      return [storagePoolDto()];
    },
    'server-1',
    'admin-token',
  );

  assert.deepEqual(calls, [{
    path: '/api/admin/servers/server-1/storage-pools/discover',
    method: 'POST',
    token: 'admin-token',
  }]);
  assert.equal(result[0].serverId, 'server-1');
});

test('storage-pool discovery blocks empty or malformed DTO responses', () => {
  assert.throws(
    () => validateStoragePoolDtos([], 'server-1'),
    /BLOCKED: storage pool discovery response was empty/,
  );
  for (const response of [
    undefined,
    null,
    {},
    [null],
    [storagePoolDto({ capability: null })],
    [storagePoolDto({ serverId: 'other-server' })],
  ]) {
    assert.throws(
      () => validateStoragePoolDtos(response, 'server-1'),
      /BLOCKED: storage pool discovery response/,
    );
  }
});

test('storage-pool discovery blocks request failures without exposing response data', async () => {
  await assert.rejects(
    () => discoverStoragePools(async () => {
      throw new Error('secret response body');
    }, 'server-1', 'admin-token'),
    (error) => {
      assert.equal(error.message, 'BLOCKED: storage pool discovery request failed');
      assert.doesNotMatch(error.message, /secret response body/);
      return true;
    },
  );
});

test('storage-pool registration uses the authenticated public PATCH contract and revisions', async () => {
  const dir = storagePoolDto({ id: 'dir-pool', incusName: 'dir-pool', revision: 4 });
  const lvm = lvmStoragePoolDto({ revision: 9 });
  const calls = [];
  const result = await registerStoragePools(
    async (path, options) => {
      calls.push({ path, ...options });
      const source = path.endsWith(dir.id) ? dir : lvm;
      return { ...source, registered: true, revision: source.revision + 1 };
    },
    'server-1',
    'admin-token',
    [dir, lvm],
  );

  assert.deepEqual(calls, [
    {
      path: '/api/admin/storage-pools/dir-pool',
      method: 'PATCH',
      token: 'admin-token',
      body: { expectedRevision: 4, registered: true },
    },
    {
      path: '/api/admin/storage-pools/pool-2',
      method: 'PATCH',
      token: 'admin-token',
      body: { expectedRevision: 9, registered: true },
    },
  ]);
  assert.deepEqual(result.map((pool) => ({
    id: pool.id,
    serverId: pool.serverId,
    incusName: pool.incusName,
    driver: pool.driver,
    capability: pool.capability,
    registered: pool.registered,
  })), [
    {
      id: 'dir-pool',
      serverId: 'server-1',
      incusName: 'dir-pool',
      driver: 'dir',
      capability: dir.capability,
      registered: true,
    },
    {
      id: 'pool-2',
      serverId: 'server-1',
      incusName: 'lvm-pool',
      driver: 'lvm',
      capability: lvm.capability,
      registered: true,
    },
  ]);
});

test('storage-pool registration rejects malformed or empty PATCH responses', async () => {
  const pool = storagePoolDto();
  for (const response of [
    undefined,
    null,
    {},
    [],
    storagePoolDto({ registered: false }),
    storagePoolDto({ serverId: 'other-server', registered: true }),
    storagePoolDto({ capability: null, registered: true }),
  ]) {
    await assert.rejects(
      () => registerStoragePools(async () => response, 'server-1', 'admin-token', [pool]),
      /BLOCKED: storage pool registration response/,
    );
  }
  assert.throws(
    () => validateRegisteredStoragePoolDto(storagePoolDto(), pool),
    /BLOCKED: storage pool registration response was not registered/,
  );
});

test('storage-pool registration reuses already registered pools without mutation', async () => {
  const pool = storagePoolDto({ registered: true, revision: 8 });
  let calls = 0;
  const result = await registerStoragePools(
    async () => {
      calls += 1;
      return pool;
    },
    'server-1',
    'admin-token',
    [pool],
  );

  assert.equal(calls, 0);
  assert.deepEqual(result, [pool]);
});

test('storage-pool registration re-reads after a revision conflict and avoids duplicate mutation', async () => {
  const pool = storagePoolDto({ revision: 3 });
  const current = storagePoolDto({ revision: 4, registered: true });
  let patchCalls = 0;
  let listCalls = 0;
  const result = await registerStoragePools(
    async (path, options) => {
      if (path === '/api/admin/storage-pools/pool-1') {
        patchCalls += 1;
        assert.deepEqual(options.body, { expectedRevision: 3, registered: true });
        const error = new Error('revision conflict');
        error.statusCode = 409;
        throw error;
      }
      listCalls += 1;
      assert.equal(path, '/api/admin/servers/server-1/storage-pools');
      assert.deepEqual(options, { token: 'admin-token' });
      return [current];
    },
    'server-1',
    'admin-token',
    [pool],
  );

  assert.equal(patchCalls, 1);
  assert.equal(listCalls, 1);
  assert.deepEqual(result, [current]);
});

test('up preserves the trusted bootstrap identity before backend startup', () => {
  const upSource = readFileSync(join(import.meta.dirname, 'up.sh'), 'utf8');
  assert.match(upSource, /bootstrap_client_cert="\$E2E_INCUS_CLIENT_CERT"/);
  assert.match(upSource, /bootstrap_client_key="\$E2E_INCUS_CLIENT_KEY"/);
  assert.match(upSource, /export E2E_INCUS_CONNECT_CLIENT_CERT="\$\{connect_client_paths\[0\]\}"/);
  assert.match(upSource, /export E2E_INCUS_CONNECT_CLIENT_KEY="\$\{connect_client_paths\[1\]\}"/);
  assert.doesNotMatch(upSource, /export E2E_INCUS_CLIENT_CERT="\$\{connect_client_paths/);
  assert.doesNotMatch(upSource, /export E2E_INCUS_CLIENT_KEY="\$\{connect_client_paths/);
  const connectAssignment = upSource.indexOf('export E2E_INCUS_CONNECT_CLIENT_CERT=');
  const backendStartup = upSource.lastIndexOf('export_control_plane_environment "$profile"');
  assert.ok(connectAssignment >= 0 && connectAssignment < backendStartup);
});

test('seed scopes the disposable certificate to the active fixture', () => {
  const seedSource = readFileSync(join(import.meta.dirname, 'seed.mjs'), 'utf8');
  assert.match(seedSource, /'E2E_INCUS_CONNECT_CLIENT_CERT'/);
  assert.match(seedSource, /'E2E_INCUS_CONNECT_CLIENT_KEY'/);
  assert.match(
    seedSource,
    /const connectCertificatePem = readRegularFile\('E2E_INCUS_CONNECT_CLIENT_CERT'\)/,
  );
  assert.match(
    seedSource,
    /const connectMetadata = certificateMetadata\(\s*connectCertificatePem,\s*connectPrivateKeyPem\s*\)/,
  );
  assert.match(
    seedSource,
    /installCertificateFixture\(\s*connectCertificatePem,\s*connectPrivateKeyPem,\s*connectMetadata,\s*'pending',\s*\)/,
  );
});

test('seed cuts over to the disposable identity before its single connect intent', () => {
  const seedSource = readFileSync(join(import.meta.dirname, 'seed.mjs'), 'utf8');
  assert.match(seedSource, /const bootstrapIncusTls = \{/);
  assert.match(seedSource, /\.\.\.bootstrapIncusTls,/);
  const firstConnect = seedSource.indexOf('const connectResult =');
  const bootstrapFixture = seedSource.indexOf(
    'installCertificateFixture(\n  bootstrapCertificatePem,',
  );
  const identityQuery = seedSource.indexOf(
    'const actualServerName = await resolveIncusServerName(incusRequest);',
  );
  const registration = seedSource.indexOf(
    'const registration = createServerRegistrationConfig(process.env, runId, actualServerName);',
  );
  const finalFixture = seedSource.indexOf('installCertificateFixture(\n  connectCertificatePem,');
  const discovery = seedSource.indexOf(
    'await discoverStoragePools(jsonRequest, server.id, token);',
  );
  const pools = seedSource.indexOf('const pools = validateStoragePoolDtos(');
  const preflight = seedSource.indexOf('const preflight = await ensurePreflight');
  assert.ok(bootstrapFixture >= 0 && bootstrapFixture < firstConnect);
  assert.ok(bootstrapFixture < identityQuery && identityQuery < registration);
  assert.ok(finalFixture > bootstrapFixture && finalFixture < firstConnect);
  assert.match(seedSource, /bootstrapMetadata,\s*'verified',\s*\)/);
  assert.match(seedSource, /connectMetadata,\s*'pending',\s*\)/);
  assert.ok(firstConnect < discovery && discovery < pools && pools < preflight);
  assert.equal((seedSource.match(/const connectResult =/g) ?? []).length, 1);
  assert.doesNotMatch(
    seedSource,
    /first connect intent runs with the trusted bootstrap certificate/,
  );
});

test('run-owned disposable certificate material is validated and cleaned', () => {
  const commonSource = readFileSync(join(import.meta.dirname, 'common.sh'), 'utf8');
  const downSource = readFileSync(join(import.meta.dirname, 'down.sh'), 'utf8');
  assert.match(commonSource, /cleanup_run_owned_incus_connect_client\(\)/);
  assert.match(commonSource, /Incus connect certificate is not owned by this run/);
  assert.match(
    downSource,
    /cleanup_run_owned_incus_connect_client "\$E2E_RUNTIME_ROOT" "\$run_id"/,
  );
});

function registrationEnv(overrides = {}) {
  return {
    E2E_INCUS_API_ENDPOINT: 'https://incus.example.test:8443',
    E2E_INCUS_PARENT_INTERFACE: 'eth0',
    E2E_INCUS_ROUTED_SUBNET: '10.20.0.0/24',
    E2E_INCUS_ROUTED_GATEWAY: '10.20.0.1',
    E2E_INCUS_LAN_RESERVED_IPS: '',
    E2E_INCUS_DNS_SERVERS: '',
    ...overrides,
  };
}

function serverFrom(config, overrides = {}) {
  return {
    id: 'server-1',
    ...config,
    serverCertFingerprint: null,
    ...overrides,
  };
}

test('registration reads the actual Incus identity and keeps the slug run-specific', async () => {
  const requestedPaths = [];
  const actualName = await resolveIncusServerName(async (path) => {
    requestedPaths.push(path);
    return { metadata: { environment: { server_name: actualIncusServerName } } };
  });
  const first = createServerRegistrationConfig(
    registrationEnv(),
    runId,
    actualName,
  );
  const second = createServerRegistrationConfig(
    registrationEnv(),
    '20260807-fedcba',
    actualName,
  );

  assert.deepEqual(requestedPaths, ['/1.0']);
  assert.equal(first.name, actualIncusServerName);
  assert.equal(second.name, actualIncusServerName);
  assert.match(first.slug, new RegExp(`^e2e-${runId}`));
  assert.match(second.slug, /^e2e-20260807-fedcba/);
  assert.notEqual(first.slug, second.slug);
});

test('registration fails closed for missing or unsafe Incus identities', async () => {
  for (const response of [
    undefined,
    null,
    {},
    { metadata: {} },
    { metadata: { environment: null } },
    { metadata: { environment: {} } },
    { metadata: { environment: { server_name: '' } } },
    { metadata: { environment: { server_name: ' bad-name' } } },
    { metadata: { environment: { server_name: 'bad name' } } },
    { metadata: { environment: { server_name: '_bad-name' } } },
    { metadata: { environment: { server_name: 'x'.repeat(129) } } },
    { metadata: { environment: { server_name: 42 } } },
  ]) {
    await assert.rejects(
      () => resolveIncusServerName(async () => response),
      /BLOCKED: Incus \/1\.0 environment\.server_name is missing or invalid/,
    );
  }
});

test('fresh seed registration creates the server through the admin API contract', async () => {
  const config = createServerRegistrationConfig(registrationEnv(), runId, actualIncusServerName);
  const calls = [];
  const result = await ensureServerRegistration({
    listServers: async () => [],
    createServer: async (body) => {
      calls.push(body);
      return serverFrom(body);
    },
    registration: config,
  });

  assert.equal(result.createdByRun, true);
  assert.equal(result.server.id, 'server-1');
  assert.deepEqual(calls, [config]);
});

test('rerunning registration reuses the exact endpoint without posting a duplicate', async () => {
  const config = createServerRegistrationConfig(registrationEnv(), runId, actualIncusServerName);
  const existing = serverFrom(config);
  let createCalls = 0;
  const result = await ensureServerRegistration({
    listServers: async () => [existing],
    createServer: async () => {
      createCalls += 1;
      throw new Error('duplicate registration');
    },
    registration: config,
    requestedServerId: 'stale-provisioned-id',
    priorServer: {
      id: existing.id,
      endpoint: existing.apiEndpoint,
      createdByRun: true,
    },
  });

  assert.equal(result.server.id, existing.id);
  assert.equal(result.createdByRun, true);
  assert.equal(createCalls, 0);
});

test('registration blocks an immutable host-network mismatch', async () => {
  const config = createServerRegistrationConfig(registrationEnv(), runId, actualIncusServerName);
  const mismatched = serverFrom(config, { parentInterface: 'lo' });

  await assert.rejects(
    ensureServerRegistration({
      listServers: async () => [mismatched],
      createServer: async () => {
        throw new Error('must not create');
      },
      registration: config,
    }),
    /BLOCKED: registered server routed-network fields/,
  );
});

test('registration blocks an endpoint and requested-id conflict', async () => {
  const config = createServerRegistrationConfig(registrationEnv(), runId, actualIncusServerName);
  const existing = serverFrom(config);

  await assert.rejects(
    ensureServerRegistration({
      listServers: async () => [existing],
      createServer: async () => {
        throw new Error('must not create');
      },
      registration: config,
      requestedServerId: 'different-server-id',
    }),
    /BLOCKED: E2E_INCUS_SERVER_ID is not registered/,
  );
});

test('registration blocks a same-endpoint name mismatch', async () => {
  const config = createServerRegistrationConfig(registrationEnv(), runId, actualIncusServerName);
  const existing = serverFrom(config, { name: 'another-incus-server' });

  await assert.rejects(
    ensureServerRegistration({
      listServers: async () => [existing],
      createServer: async () => {
        throw new Error('must not create');
      },
      registration: config,
    }),
    /BLOCKED: registered server name does not match the validated Incus identity/,
  );
});

test('registration blocks a foreign run slug on the exact endpoint', async () => {
  const config = createServerRegistrationConfig(registrationEnv(), runId, actualIncusServerName);
  const existing = serverFrom(config, { slug: 'e2e-another-run' });

  await assert.rejects(
    ensureServerRegistration({
      listServers: async () => [existing],
      createServer: async () => {
        throw new Error('must not create');
      },
      registration: config,
    }),
    /BLOCKED: registered server slug does not match the run-scoped identity/,
  );
});

test('registration blocks an actual name already bound to another endpoint', async () => {
  const config = createServerRegistrationConfig(registrationEnv(), runId, actualIncusServerName);
  const existing = serverFrom(config, {
    apiEndpoint: 'https://other-incus.example.test:8443',
  });

  await assert.rejects(
    ensureServerRegistration({
      listServers: async () => [existing],
      createServer: async () => {
        throw new Error('must not create');
      },
      registration: config,
    }),
    /BLOCKED: E2E_INCUS server name belongs to a different API endpoint/,
  );
});

test('cleanup reads PEM contents and deletes only a run-owned server', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nyabase-e2e-cleanup-'));
  try {
    const caPath = join(directory, 'ca.pem');
    const certPath = join(directory, 'client.crt');
    const keyPath = join(directory, 'client.key');
    writeFileSync(caPath, 'CA PEM CONTENT');
    writeFileSync(certPath, 'CERT PEM CONTENT');
    writeFileSync(keyPath, 'KEY PEM CONTENT');
    const tls = readTlsOptions({
      E2E_EDGE_CA_FILE: caPath,
      E2E_EDGE_CLIENT_CERT: certPath,
      E2E_EDGE_CLIENT_KEY: keyPath,
    });
    assert.deepEqual(tls.ca, readFileSync(caPath));
    assert.deepEqual(tls.cert, readFileSync(certPath));
    assert.deepEqual(tls.key, readFileSync(keyPath));
    assert.notEqual(tls.ca.toString(), caPath);

    const calls = [];
    const ownedState = {
      runId,
      server: { id: 'server-1', createdByRun: true },
      image: { id: 'image-1' },
    };
    await removeRunOwnedServer(
      async (path, options = {}) => {
        calls.push({ path, method: options.method ?? 'GET' });
        if (path.endsWith('/assignments')) return [];
        if (path.includes('/servers/')) {
          const error = new Error('not found');
          error.statusCode = 404;
          throw error;
        }
        return null;
      },
      ownedState,
      runId,
      'token',
    );
    assert.deepEqual(calls, [
      {
        path: '/api/admin/images/image-1/assignments/server-1',
        method: 'DELETE',
      },
      {
        path: '/api/admin/images/image-1/assignments',
        method: 'GET',
      },
      {
        path: '/api/admin/servers/server-1',
        method: 'DELETE',
      },
    ]);

    const untouchedCalls = [];
    const preExistingState = {
      runId,
      server: { id: 'server-2', createdByRun: false },
      image: { id: 'image-1' },
    };
    assert.equal(shouldDeleteRunServer(preExistingState, runId), false);
    await removeRunOwnedServer(
      async (...args) => {
        untouchedCalls.push(args);
      },
      preExistingState,
      runId,
      'token',
    );
    assert.equal(untouchedCalls.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cleanup removes run-owned assignment and image without deleting a reused image', async () => {
  const ownedImageState = {
    runId,
    server: { id: 'server-1', createdByRun: true },
    image: {
      id: 'image-1',
      createdByRun: true,
      assignmentCreatedByRun: true,
    },
  };
  assert.equal(shouldCleanupRunAssignment(ownedImageState, runId), true);
  assert.equal(shouldDeleteRunImage(ownedImageState, runId), true);

  const ownedCalls = [];
  const databaseCleanup = [];
  await removeRunOwnedServer(
    async (path, options = {}) => {
      ownedCalls.push({ path, method: options.method ?? 'GET' });
      if (path.endsWith('/assignments')) return [];
      if (
        path === '/api/admin/images/image-1'
        || path === '/api/admin/servers/server-1'
      ) {
        if ((options.method ?? 'GET') === 'GET') {
          const error = new Error('not found');
          error.statusCode = 404;
          throw error;
        }
        return null;
      }
      return null;
    },
    ownedImageState,
    runId,
    'token',
    async (serverId) => {
      databaseCleanup.push(serverId);
    },
  );
  assert.deepEqual(databaseCleanup, ['server-1']);
  assert.deepEqual(ownedCalls, [
    {
      path: '/api/admin/images/image-1/assignments/server-1',
      method: 'DELETE',
    },
    {
      path: '/api/admin/images/image-1/assignments',
      method: 'GET',
    },
    {
      path: '/api/admin/images/image-1',
      method: 'DELETE',
    },
    {
      path: '/api/admin/images/image-1',
      method: 'GET',
    },
    {
      path: '/api/admin/servers/server-1',
      method: 'DELETE',
    },
    {
      path: '/api/admin/servers/server-1',
      method: 'GET',
    },
  ]);

  const reusedImageState = {
    runId,
    server: { id: 'server-1', createdByRun: false },
    image: {
      id: 'image-1',
      createdByRun: false,
      assignmentCreatedByRun: true,
    },
  };
  assert.equal(shouldDeleteRunImage(reusedImageState, runId), false);
  const reusedCalls = [];
  await removeRunOwnedServer(
    async (path, options = {}) => {
      reusedCalls.push({ path, method: options.method ?? 'GET' });
      if (path.endsWith('/assignments')) return [];
      if (path.includes('/assignments/')) return null;
      throw new Error('reused image must not be deleted');
    },
    reusedImageState,
    runId,
    'token',
  );
  assert.deepEqual(reusedCalls, [
    {
      path: '/api/admin/images/image-1/assignments/server-1',
      method: 'DELETE',
    },
    {
      path: '/api/admin/images/image-1/assignments',
      method: 'GET',
    },
  ]);
});
