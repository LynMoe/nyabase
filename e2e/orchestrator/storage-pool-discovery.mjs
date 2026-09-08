const STORAGE_POOL_DRIVERS = new Set([
  'dir',
  'btrfs',
  'zfs',
  'lvm',
  'lvmcluster',
  'ceph',
  'cephfs',
]);
const STORAGE_POOL_RESIZE_FAMILIES = new Set(['quota_online', 'block_backed']);
const RESOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function blocked(message) {
  throw new Error(`BLOCKED: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isResourceId(value) {
  return typeof value === 'string' && RESOURCE_ID_RE.test(value);
}

function isNullableString(value) {
  return value === null || typeof value === 'string';
}

function isNullableFiniteNumber(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isCapability(value) {
  return isRecord(value)
    && typeof value.growOnline === 'boolean'
    && typeof value.shrinkOnline === 'boolean'
    && typeof value.shrinkRequiresStop === 'boolean'
    && typeof value.shrinkNever === 'boolean'
    && typeof value.enforceUsageFloor === 'boolean';
}

function isStoragePoolDto(value, serverId) {
  return isRecord(value)
    && isResourceId(value.id)
    && value.serverId === serverId
    && isResourceId(value.incusName)
    && STORAGE_POOL_DRIVERS.has(value.driver)
    && STORAGE_POOL_RESIZE_FAMILIES.has(value.resizeFamily)
    && isNullableString(value.displayName)
    && typeof value.rootDiskCapable === 'boolean'
    && typeof value.shareable === 'boolean'
    && isNullableString(value.blockFilesystem)
    && isNullableString(value.sharedBackendId)
    && isNullableFiniteNumber(value.totalBytes)
    && isNullableFiniteNumber(value.usedBytes)
    && (value.quotaEffective === null || typeof value.quotaEffective === 'boolean')
    && typeof value.registered === 'boolean'
    && isCapability(value.capability)
    && isNullableString(value.lastObservedAt)
    && Number.isSafeInteger(value.revision)
    && value.revision >= 1;
}

export function validateStoragePoolDtos(value, serverId, label = 'storage pool discovery') {
  if (!Array.isArray(value)) {
    blocked(`${label} response was not an array`);
  }
  if (value.length === 0) {
    blocked(`${label} response was empty`);
  }
  if (value.some((pool) => !isStoragePoolDto(pool, serverId))) {
    blocked(`${label} response contained a malformed storage pool DTO`);
  }
  if (value.some((pool) => pool.driver === 'cephfs' || pool.shareable === true)) {
    blocked(`${label} local pools contained a CephFS/shareable executor`);
  }
  return value;
}

function isDiscoverIssue(value) {
  return isRecord(value)
    && typeof value.code === 'string'
    && typeof value.message === 'string'
    && isNullableString(value.identityKey)
    && isNullableString(value.expectedFsid)
    && isNullableString(value.discoveredFsid)
    && isNullableString(value.existingIdentityKey)
    && isNullableString(value.serverId)
    && isNullableString(value.incusName)
    && isNullableString(value.poolId);
}

export function validateStoragePoolDiscoverResult(
  value,
  serverId,
  label = 'storage pool discovery',
) {
  if (!isRecord(value) || !Array.isArray(value.pools) || !Array.isArray(value.identityConflicts)) {
    blocked(`${label} response was not a discover envelope`);
  }
  if (value.identityConflicts.some((issue) => !isDiscoverIssue(issue))) {
    blocked(`${label} response contained a malformed discover issue`);
  }
  return {
    pools: validateStoragePoolDtos(value.pools, serverId, label),
    identityConflicts: value.identityConflicts,
  };
}

const STORAGE_POOL_IDENTITY_FIELDS = [
  'id',
  'serverId',
  'incusName',
  'driver',
  'resizeFamily',
  'rootDiskCapable',
  'shareable',
  'blockFilesystem',
  'sharedBackendId',
  'quotaEffective',
];
const CAPABILITY_FIELDS = [
  'growOnline',
  'shrinkOnline',
  'shrinkRequiresStop',
  'shrinkNever',
  'enforceUsageFloor',
];

function sameStoragePoolIdentity(actual, expected) {
  return STORAGE_POOL_IDENTITY_FIELDS.every((field) => actual[field] === expected[field])
    && CAPABILITY_FIELDS.every((field) => actual.capability[field] === expected.capability[field]);
}

export function validateRegisteredStoragePoolDto(
  value,
  expected,
  label = 'storage pool registration',
) {
  if (!isStoragePoolDto(value, expected.serverId)) {
    blocked(`${label} response was malformed or empty`);
  }
  if (!sameStoragePoolIdentity(value, expected)) {
    blocked(`${label} response did not match the discovered pool identity`);
  }
  if (value.registered !== true) {
    blocked(`${label} response was not registered`);
  }
  return value;
}

async function readPersistedStoragePools(request, serverId, token, label) {
  let response;
  try {
    response = await request(`/api/admin/servers/${encodeURIComponent(serverId)}/storage-pools`, {
      token,
    });
  } catch {
    blocked(`${label} request failed`);
  }
  return validateStoragePoolDtos(response, serverId, label);
}

async function registerStoragePool(request, serverId, token, pool) {
  if (pool.registered === true) {
    return validateRegisteredStoragePoolDto(pool, pool);
  }

  let response;
  try {
    response = await request(`/api/admin/storage-pools/${encodeURIComponent(pool.id)}`, {
      method: 'PATCH',
      token,
      body: {
        expectedRevision: pool.revision,
        registered: true,
      },
    });
  } catch (error) {
    if (error?.statusCode !== 409) {
      blocked('storage pool registration request failed');
    }
    const current = await readPersistedStoragePools(
      request,
      serverId,
      token,
      'storage pool registration conflict re-read',
    );
    const latest = current.find((candidate) => candidate.id === pool.id);
    if (!latest) {
      blocked('storage pool registration conflict did not return the target pool');
    }
    return validateRegisteredStoragePoolDto(
      latest,
      pool,
      'storage pool registration conflict re-read',
    );
  }
  return validateRegisteredStoragePoolDto(response, pool);
}

export async function registerStoragePools(request, serverId, token, pools) {
  if (typeof request !== 'function') {
    blocked('storage pool registration request client is unavailable');
  }
  if (!Array.isArray(pools) || pools.length === 0) {
    blocked('storage pool registration set was empty');
  }
  const registered = [];
  for (const pool of pools) {
    if (!isStoragePoolDto(pool, serverId)) {
      blocked('storage pool registration input was malformed');
    }
    registered.push(await registerStoragePool(request, serverId, token, pool));
  }
  return registered;
}

export async function discoverStoragePools(request, serverId, token) {
  if (typeof request !== 'function') {
    blocked('storage pool discovery request client is unavailable');
  }
  let response;
  try {
    response = await request(`/api/admin/servers/${serverId}/storage-pools/discover`, {
      method: 'POST',
      token,
    });
  } catch {
    blocked('storage pool discovery request failed');
  }
  return validateStoragePoolDiscoverResult(response, serverId);
}

export async function listSharedExecutors(request, backendId, token) {
  if (typeof request !== 'function') {
    blocked('shared executor list request client is unavailable');
  }
  let response;
  try {
    response = await request(
      `/api/admin/shared-backends/${encodeURIComponent(backendId)}/executors`,
      { token },
    );
  } catch {
    blocked('shared executor list request failed');
  }
  if (!Array.isArray(response)) {
    blocked('shared executor list response was not an array');
  }
  return response;
}

export async function discoverSharedExecutors(request, backendId, token, serverId) {
  if (typeof request !== 'function') {
    blocked('shared executor discovery request client is unavailable');
  }
  let response;
  try {
    response = await request(
      `/api/admin/shared-backends/${encodeURIComponent(backendId)}/executors/discover`,
      {
        method: 'POST',
        token,
        body: serverId ? { serverId } : {},
      },
    );
  } catch {
    blocked('shared executor discovery request failed');
  }
  if (!isRecord(response) || !Array.isArray(response.executors) || !Array.isArray(response.identityConflicts)) {
    blocked('shared executor discovery response was not a discover envelope');
  }
  return response;
}

export async function registerSharedExecutor(request, backendId, executor, token) {
  if (typeof request !== 'function') {
    blocked('shared executor registration request client is unavailable');
  }
  if (!isRecord(executor) || !isResourceId(executor.id)) {
    blocked('shared executor registration input was malformed');
  }
  if (executor.registered === true) return executor;
  let response;
  try {
    response = await request(
      `/api/admin/shared-backends/${encodeURIComponent(backendId)}/executors/${encodeURIComponent(executor.id)}`,
      {
        method: 'PATCH',
        token,
        body: {
          expectedRevision: executor.revision,
          registered: true,
        },
      },
    );
  } catch {
    blocked('shared executor registration request failed');
  }
  if (!isRecord(response) || response.registered !== true) {
    blocked('shared executor registration response was not registered');
  }
  return response;
}

export async function findAndRegisterCephExecutor(
  request,
  backendId,
  serverId,
  incusName,
  token,
  label = 'shared executor',
) {
  let executors = await listSharedExecutors(request, backendId, token);
  let found = executors.find((row) => row.serverId === serverId && row.incusName === incusName);
  if (!found) {
    await discoverSharedExecutors(request, backendId, token, serverId);
    executors = await listSharedExecutors(request, backendId, token);
    found = executors.find((row) => row.serverId === serverId && row.incusName === incusName);
  }
  if (!found) {
    blocked(`${label} ${incusName} was not mapped on ${serverId}`);
  }
  if (!found.registered) {
    found = await registerSharedExecutor(request, backendId, found, token);
  }
  return found;
}
