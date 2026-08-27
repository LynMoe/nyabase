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
  return value;
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
  return validateStoragePoolDtos(response, serverId);
}
