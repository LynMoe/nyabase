const nodeKeys = new Set(['node1', 'node2']);
const fsTypes = new Set(['nfs', 'cephfs']);
const actions = new Set(['probe', 'write', 'read', 'holdBusy', 'releaseBusy']);
const mountIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const markerPattern = /^[A-Za-z0-9._:-]{1,128}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactKeys(value, expected) {
  invariant(
    value && typeof value === 'object' && !Array.isArray(value),
    'Remote storage input must be an object',
  );
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    'Remote storage input has unknown or missing fields',
  );
}

/**
 * Validate the closed provider vocabulary before any Docker or mount operation.
 * Callers can select only a current-run resource identity and a fixed proof
 * action; paths, hosts, mount options, secrets, and commands are never accepted.
 */
export function validateRemoteStorageInput(value, expectedRunId) {
  const action = value?.action;
  const needsMarker = action === 'write' || action === 'read';
  assertExactKeys(
    value,
    needsMarker
      ? ['action', 'fsType', 'marker', 'mountId', 'nodeKey', 'runId']
      : ['action', 'fsType', 'mountId', 'nodeKey', 'runId'],
  );
  invariant(value.runId === expectedRunId, 'Remote storage operation run identity mismatch');
  invariant(nodeKeys.has(value.nodeKey), 'Invalid storage node');
  invariant(
    typeof value.mountId === 'string' && mountIdPattern.test(value.mountId),
    'Remote storage mount identity must be a v4 UUID',
  );
  invariant(fsTypes.has(value.fsType), 'Invalid remote filesystem type');
  invariant(actions.has(action), 'Invalid remote storage action');
  if (needsMarker) {
    invariant(
      typeof value.marker === 'string' && markerPattern.test(value.marker),
      'Remote storage marker contract mismatch',
    );
  }
  return value;
}
