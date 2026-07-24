export const manifestSchemaVersion = 2;

export function assertManifestForRun(manifest, runId, label = 'resource manifest') {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${label} must be an object`);
  }
  if (manifest.schemaVersion !== manifestSchemaVersion) {
    throw new Error(`${label} schemaVersion must be ${manifestSchemaVersion}`);
  }
  if (manifest.runId !== runId) {
    throw new Error(`${label} runId mismatch`);
  }
  if (!Array.isArray(manifest.resources)) {
    throw new Error(`${label} resources must be an array`);
  }
  return manifest;
}

export function assertResumableManifest(manifest, runId) {
  assertManifestForRun(manifest, runId);
  if (manifest.cleanup !== null) {
    throw new Error('resource manifest is terminal and runId reuse is forbidden');
  }
  if (manifest.phase === 'cleaned' || manifest.phase === 'cleanup_failed') {
    throw new Error('resource manifest is in a terminal phase');
  }
  return manifest;
}

export function assertCleanManifest(manifest, runId, label = 'cleaned manifest') {
  assertManifestForRun(manifest, runId, label);
  if (manifest.phase !== 'cleaned' || manifest.cleanup?.status !== 'clean') {
    throw new Error(`${label} does not prove clean teardown`);
  }
  return manifest;
}
