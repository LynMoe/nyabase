const actions = new Set([
  'sshHostKey',
  'sshExec',
  'sftpRoundTrip',
  'sshHoldStart',
  'sshHoldProbe',
  'sshHoldRelease',
  'httpGet',
  'websocketEcho',
]);
const nodeKeys = new Set(['node1', 'node2']);
const markerPattern = /^[A-Za-z0-9._:-]{1,96}$/;
const containerNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const hostnamePattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected) {
  invariant(
    value && typeof value === 'object' && !Array.isArray(value),
    'Proxy client input must be an object',
  );
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    'Proxy client input has unknown or missing fields',
  );
}

/** Validate a fixed external-client vocabulary without commands, paths, IPs, keys, or tokens. */
export function validateProxyClientInput(value, expectedRunId) {
  const action = value?.action;
  invariant(actions.has(action), 'Invalid proxy client action');
  if (action === 'sshHostKey' || action === 'sshHoldProbe' || action === 'sshHoldRelease') {
    exactKeys(value, ['action', 'runId']);
  } else if (['sshExec', 'sftpRoundTrip', 'sshHoldStart'].includes(action)) {
    exactKeys(value, ['action', 'containerName', 'marker', 'nodeKey', 'runId']);
    invariant(nodeKeys.has(value.nodeKey), 'Invalid proxy target node');
    invariant(containerNamePattern.test(value.containerName), 'Invalid proxy target container name');
    invariant(markerPattern.test(value.marker), 'Invalid proxy client marker');
  } else {
    exactKeys(value, ['action', 'hostname', 'marker', 'runId']);
    invariant(hostnamePattern.test(value.hostname), 'Invalid HTTP proxy hostname');
    invariant(markerPattern.test(value.marker), 'Invalid proxy client marker');
  }
  invariant(value.runId === expectedRunId, 'Proxy client operation run identity mismatch');
  return value;
}
