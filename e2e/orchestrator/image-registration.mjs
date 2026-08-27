const IMAGE_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const LOGIN_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
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

function isImageDto(value) {
  return isRecord(value)
    && isResourceId(value.id)
    && typeof value.name === 'string'
    && value.name.trim().length > 0
    && typeof value.alias === 'string'
    && IMAGE_ALIAS_RE.test(value.alias)
    && (value.fingerprint === null || /^[0-9a-f]{64}$/i.test(value.fingerprint))
    && isNullableString(value.description)
    && typeof value.loginUser === 'string'
    && LOGIN_USER_RE.test(value.loginUser)
    && (
      value.minRootSizeBytes === null
      || (
        Number.isSafeInteger(value.minRootSizeBytes)
        && value.minRootSizeBytes > 0
      )
    )
    && typeof value.networkManagedExternally === 'boolean'
    && typeof value.isActive === 'boolean'
    && typeof value.deleting === 'boolean'
    && Number.isSafeInteger(value.cleanupGeneration)
    && value.cleanupGeneration >= 0
    && Number.isSafeInteger(value.revision)
    && value.revision >= 1
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
    && Array.isArray(value.assignments);
}

export function validateImageDto(value, label = 'image') {
  if (!isImageDto(value)) {
    blocked(`${label} response was malformed or empty`);
  }
  return value;
}

export function buildImageRegistrationConfig(runId, env = process.env) {
  if (!/^[a-z0-9][a-z0-9-]{5,63}$/.test(runId ?? '')) {
    blocked('image registration run id is unsafe');
  }
  const alias = typeof env.E2E_INCUS_IMAGE_ALIAS === 'string'
    ? env.E2E_INCUS_IMAGE_ALIAS.trim()
    : undefined;
  const loginUser = typeof env.E2E_SSH_USER === 'string'
    ? env.E2E_SSH_USER.trim()
    : undefined;
  if (!alias || !IMAGE_ALIAS_RE.test(alias)) {
    blocked('E2E_INCUS_IMAGE_ALIAS is missing or unsafe');
  }
  if (!loginUser || !LOGIN_USER_RE.test(loginUser)) {
    blocked('E2E_SSH_USER is missing or unsafe');
  }
  return {
    name: `e2e-${runId}-sshd`,
    alias,
    loginUser,
    networkManagedExternally: true,
  };
}

function isCompatibleImage(image, config) {
  return image.name === config.name
    && image.alias === config.alias
    && image.loginUser === config.loginUser
    && image.minRootSizeBytes === null
    && image.networkManagedExternally === true
    && image.isActive === true
    && image.deleting === false;
}

function inheritedImageOwnership(image, priorImage, config) {
  return priorImage?.createdByRun === true
    && priorImage.id === image.id
    && priorImage.alias === config.alias;
}

export async function ensureImageRegistration({
  listImages,
  createImage,
  token,
  runId,
  env = process.env,
  priorImage,
}) {
  if (typeof listImages !== 'function' || typeof createImage !== 'function') {
    blocked('image registration request client is unavailable');
  }
  const config = buildImageRegistrationConfig(runId, env);

  let listed;
  try {
    listed = await listImages(token);
  } catch {
    blocked('image registration list request failed');
  }
  if (!Array.isArray(listed)) {
    blocked('admin image list response was not an array');
  }
  if (listed.some((entry) => !isImageDto(entry))) {
    blocked('admin image list response contained a malformed image DTO');
  }

  const matches = listed.filter((entry) => entry.alias === config.alias);
  if (matches.length > 1) {
    blocked('configured image alias matched multiple registered images');
  }
  if (matches.length === 1) {
    const image = validateImageDto(matches[0], 'configured image');
    if (!isCompatibleImage(image, config)) {
      blocked('configured image alias is registered with incompatible configuration');
    }
    return {
      image,
      createdByRun: inheritedImageOwnership(image, priorImage, config),
      request: config,
    };
  }

  let created;
  try {
    created = await createImage(config, token);
  } catch (error) {
    if (error?.statusCode === 409) {
      blocked('image registration conflicted with an existing image');
    }
    blocked('image registration request failed');
  }
  const image = validateImageDto(created, 'image registration');
  if (!isCompatibleImage(image, config)) {
    blocked('image registration response did not match the requested configuration');
  }
  return {
    image,
    createdByRun: true,
    request: config,
  };
}
