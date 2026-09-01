import {
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from 'node:https';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export function readRegularFile(env, name) {
  const path = env[name];
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) {
    throw new Error(`${name} must point to a readable regular file`);
  }
  try {
    if (!lstatSync(path).isFile()) {
      throw new Error(`${name} must point to a readable regular file`);
    }
    return readFileSync(path);
  } catch {
    throw new Error(`${name} must point to a readable regular file`);
  }
}

function readOptionalFile(env, name) {
  if (!env[name]?.trim()) return undefined;
  return readRegularFile(env, name);
}

export function readTlsOptions(env = process.env) {
  const certConfigured = Boolean(env.E2E_EDGE_CLIENT_CERT?.trim());
  const keyConfigured = Boolean(env.E2E_EDGE_CLIENT_KEY?.trim());
  if (certConfigured !== keyConfigured) {
    throw new Error('E2E_EDGE_CLIENT_CERT and E2E_EDGE_CLIENT_KEY must be configured together');
  }
  return {
    ca: readRegularFile(env, 'E2E_EDGE_CA_FILE'),
    cert: readOptionalFile(env, 'E2E_EDGE_CLIENT_CERT'),
    key: readOptionalFile(env, 'E2E_EDGE_CLIENT_KEY'),
  };
}

export function isE2eResourceName(name, runId) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.startsWith('e2e-')) return true;
  return typeof runId === 'string' && runId.length > 0 && name.includes(runId);
}

export function shouldDeleteRunServer(seedState, runId) {
  return seedState?.runId === runId
    && seedState.server?.createdByRun === true
    && typeof seedState.server.id === 'string'
    && seedState.server.id.length > 0;
}

export function labServersToDelete(seedState, runId) {
  if (seedState?.runId !== runId || !Array.isArray(seedState.labServers)) return [];
  return seedState.labServers.filter((entry) => (
    entry?.createdByRun === true && typeof entry.id === 'string' && entry.id.length > 0
  ));
}

export function shouldCleanupRunAssignment(seedState, runId) {
  return seedState?.runId === runId
    && seedState.image?.assignmentCreatedByRun === true
    && typeof seedState.server?.id === 'string'
    && seedState.server.id.length > 0
    && typeof seedState.image?.id === 'string'
    && seedState.image.id.length > 0;
}

export function shouldDeleteRunImage(seedState, runId) {
  return shouldCleanupRunAssignment(seedState, runId)
    && seedState.image.createdByRun === true;
}

function readSeedState(env, runId) {
  const path = env.E2E_SEED_STATE?.trim();
  if (!path) return undefined;
  if (!existsSync(path)) return undefined;
  let state;
  try {
    state = JSON.parse(readRegularFile(env, 'E2E_SEED_STATE').toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('E2E_SEED_STATE is not valid JSON');
    }
    throw error;
  }
  if (state?.runId !== runId) {
    throw new Error('E2E_SEED_STATE belongs to another run');
  }
  return state;
}

function createJsonRequest(baseUrl, tls, runId) {
  return function jsonRequest(path, { method = 'GET', body, token } = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolveRequest, reject) => {
      const req = request(new URL(path, baseUrl), {
        method,
        ...tls,
        rejectUnauthorized: true,
        headers: {
          accept: 'application/json',
          ...(payload ? {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'x-nyabase-e2e-run': runId,
        },
      }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => {
          let value = null;
          try {
            value = text ? JSON.parse(text) : null;
          } catch {
            reject(new Error(`${method} ${path} returned invalid JSON`));
            return;
          }
          if ((response.statusCode ?? 500) >= 400) {
            const error = new Error(`${method} ${path} returned ${response.statusCode}`);
            error.statusCode = response.statusCode;
            reject(error);
            return;
          }
          resolveRequest(value);
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  };
}

async function waitGone(jsonRequest, path, token) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await jsonRequest(path, { token });
    } catch (error) {
      if (error?.statusCode === 404) return;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`cleanup did not remove ${path}`);
}

async function waitAssignmentGone(jsonRequest, path, serverId, token) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const assignments = await jsonRequest(path, { token });
      if (!assignments.some((entry) => entry.serverId === serverId)) return;
    } catch (error) {
      if (error?.statusCode === 404) return;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`cleanup did not remove image assignment for ${serverId}`);
}

async function runPsql(sql, env, runId) {
  const databaseUrl = env.E2E_DATABASE_URL?.trim();
  const runtimeRoot = env.E2E_RUNTIME_ROOT?.trim();
  if (!databaseUrl || !runtimeRoot) {
    throw new Error('cleanup requires E2E_DATABASE_URL and E2E_RUNTIME_ROOT for a run-owned server');
  }
  const sqlPath = join(runtimeRoot, `cleanup-${runId}.sql`);
  writeFileSync(sqlPath, `${sql.trim()}\n`, { mode: 0o600 });
  try {
    return await execFileAsync('psql', [
      databaseUrl,
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-P',
      'tuples_only=on',
      '-P',
      'format=unaligned',
      '-v',
      `server_id=${env.E2E_CLEANUP_SERVER_ID}`,
      '-f',
      sqlPath,
    ], {
      timeout: 30_000,
      maxBuffer: 128 * 1024,
    });
  } catch {
    throw new Error('run-owned server database cleanup failed');
  } finally {
    rmSync(sqlPath, { force: true });
  }
}

async function cleanupOwnedServerDatabase(env, runId, serverId) {
  if (!/^[0-9a-f-]{36}$/i.test(serverId)) {
    throw new Error('run-owned server state has an invalid server identity');
  }
  const countResult = await runPsql(`
SELECT
  (SELECT COUNT(*) FROM infra.servers WHERE id = :'server_id'::uuid) || '|' ||
  (SELECT COUNT(*) FROM control.containers WHERE server_id = :'server_id'::uuid) || '|' ||
  (SELECT COUNT(*) FROM control.volumes WHERE server_id = :'server_id'::uuid) || '|' ||
  (SELECT COUNT(*) FROM control.volumes
    WHERE pool_id IN (SELECT id FROM infra.storage_pools WHERE server_id = :'server_id'::uuid)) || '|' ||
  (SELECT COUNT(*) FROM control.container_network_claims
    WHERE server_id = :'server_id'::uuid AND container_id IS NOT NULL) || '|' ||
  (SELECT COUNT(*) FROM control.container_ssh_routes WHERE server_id = :'server_id'::uuid) || '|' ||
  (SELECT COUNT(*) FROM control.container_gpu_claims WHERE server_id = :'server_id'::uuid) || '|' ||
  (SELECT COUNT(*) FROM infra.image_server_assignments WHERE server_id = :'server_id'::uuid);
`, { ...env, E2E_CLEANUP_SERVER_ID: serverId }, runId);
  const counts = countResult.stdout.trim().split('|').map((value) => Number(value));
  if (counts.length !== 8 || counts.some((value) => !Number.isSafeInteger(value))) {
    throw new Error('run-owned server database cleanup returned an invalid reference report');
  }
  if (counts[0] === 0) return;
  if (counts.slice(1).some((value) => value > 0)) {
    throw new Error('run-owned server still has managed resources after cleanup');
  }

  await runPsql(`
BEGIN;
DELETE FROM control.container_network_claims
WHERE server_id = :'server_id'::uuid AND container_id IS NULL;
DELETE FROM control.container_ssh_routes
WHERE server_id = :'server_id'::uuid;
DELETE FROM control.container_gpu_claims
WHERE server_id = :'server_id'::uuid;
DELETE FROM iam.storage_pool_grants
WHERE pool_id IN (
  SELECT id FROM infra.storage_pools WHERE server_id = :'server_id'::uuid
);
DELETE FROM control.authorization_dependencies
WHERE server_id = :'server_id'::uuid
   OR pool_id IN (
     SELECT id FROM infra.storage_pools WHERE server_id = :'server_id'::uuid
   );
DELETE FROM iam.server_grants
WHERE server_id = :'server_id'::uuid;
DELETE FROM control.intents
WHERE server_id = :'server_id'::uuid;
DELETE FROM control.reconcile_claims
WHERE server_id = :'server_id'::uuid;
DELETE FROM control.grant_expiry_enforcement
WHERE server_id = :'server_id'::uuid;
DELETE FROM system.incus_client_certificate_trusts
WHERE server_id = :'server_id'::uuid;
UPDATE infra.servers
SET system_pool_id = NULL
WHERE id = :'server_id'::uuid;
DELETE FROM infra.storage_pools
WHERE server_id = :'server_id'::uuid;
COMMIT;
`, { ...env, E2E_CLEANUP_SERVER_ID: serverId }, runId);
}

export async function removeRunOwnedServer(
  jsonRequest,
  seedState,
  runId,
  token,
  cleanupDatabase = async () => {},
) {
  const serverOwned = shouldDeleteRunServer(seedState, runId);
  const assignmentOwned = shouldCleanupRunAssignment(seedState, runId);
  const imageOwned = shouldDeleteRunImage(seedState, runId);
  if (!serverOwned && !assignmentOwned && !imageOwned) return;
  const serverId = seedState.server?.id;
  const imageId = seedState.image?.id;
  if ((serverOwned || assignmentOwned || imageOwned) && !imageId) {
    throw new Error('run-owned seed state is missing its image identity');
  }

  if (serverOwned || assignmentOwned) {
    try {
      await jsonRequest(
        `/api/admin/images/${encodeURIComponent(imageId)}/assignments/${encodeURIComponent(serverId)}`,
        { method: 'DELETE', token },
      );
      await waitAssignmentGone(
        jsonRequest,
        `/api/admin/images/${encodeURIComponent(imageId)}/assignments`,
        serverId,
        token,
      );
    } catch (error) {
      if (error?.statusCode !== 404) throw error;
    }
  }

  if (imageOwned) {
    try {
      await jsonRequest(`/api/admin/images/${encodeURIComponent(imageId)}`, {
        method: 'DELETE',
        token,
      });
    } catch (error) {
      if (error?.statusCode !== 404) throw error;
    }
    await waitGone(
      jsonRequest,
      `/api/admin/images/${encodeURIComponent(imageId)}`,
      token,
    );
  }

  if (!serverOwned) return;
  await cleanupDatabase(serverId);
  try {
    await jsonRequest(`/api/admin/servers/${encodeURIComponent(serverId)}`, {
      method: 'DELETE',
      token,
    });
  } catch (error) {
    if (error?.statusCode !== 404) throw error;
    return;
  }
  await waitGone(
    jsonRequest,
    `/api/admin/servers/${encodeURIComponent(serverId)}`,
    token,
  );
  for (const extra of labServersToDelete(seedState, runId)) {
    if (imageId) {
      try {
        await jsonRequest(
          `/api/admin/images/${encodeURIComponent(imageId)}/assignments/${encodeURIComponent(extra.id)}`,
          { method: 'DELETE', token },
        );
      } catch (error) {
        if (error?.statusCode !== 404) throw error;
      }
    }
    await cleanupDatabase(extra.id);
    try {
      await jsonRequest(`/api/admin/servers/${encodeURIComponent(extra.id)}`, {
        method: 'DELETE',
        token,
      });
    } catch (error) {
      if (error?.statusCode !== 404) throw error;
      continue;
    }
    await waitGone(
      jsonRequest,
      `/api/admin/servers/${encodeURIComponent(extra.id)}`,
      token,
    );
  }
}

async function main() {
  const [, , runId] = process.argv;
  if (!/^[a-z0-9][a-z0-9-]{5,63}$/.test(runId ?? '')) {
    throw new Error('unsafe run id');
  }
  const baseUrl = new URL(process.env.E2E_BASE_URL);
  const tls = readTlsOptions();
  const jsonRequest = createJsonRequest(baseUrl, tls, runId);
  const seedState = readSeedState(process.env, runId);
  const session = await jsonRequest('/api/auth/login', {
    method: 'POST',
    body: {
      username: process.env.E2E_ADMIN_USERNAME,
      password: process.env.E2E_ADMIN_PASSWORD,
    },
  });
  const token = session.accessToken;
  const containers = await jsonRequest('/api/admin/containers', { token });
  for (const container of containers.filter((entry) => isE2eResourceName(entry.name, runId))) {
    await jsonRequest(`/api/admin/containers/${container.id}/actions/delete`, {
      method: 'POST',
      token,
    });
    await waitGone(jsonRequest, `/api/admin/containers/${container.id}`, token);
  }
  const volumes = await jsonRequest('/api/admin/volumes', { token });
  for (const volume of volumes.filter((entry) => isE2eResourceName(entry.name, runId))) {
    await jsonRequest(`/api/admin/volumes/${volume.id}`, {
      method: 'DELETE',
      token,
    });
    await waitGone(jsonRequest, `/api/admin/volumes/${volume.id}`, token);
  }
  const sharedVolumes = await jsonRequest('/api/admin/shared-volumes', { token });
  for (const volume of sharedVolumes.filter((entry) => isE2eResourceName(entry.name, runId))) {
    await jsonRequest(`/api/admin/shared-volumes/${volume.id}`, {
      method: 'DELETE',
      token,
    });
    await waitGone(jsonRequest, `/api/admin/shared-volumes/${volume.id}`, token);
  }
  await removeRunOwnedServer(
    jsonRequest,
    seedState,
    runId,
    token,
    (serverId) => cleanupOwnedServerDatabase(process.env, runId, serverId),
  );
  await jsonRequest('/api/auth/logout', {
    method: 'POST',
    body: { refreshToken: session.refreshToken },
  });
  console.log(`cleanup=passed run=${runId}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
