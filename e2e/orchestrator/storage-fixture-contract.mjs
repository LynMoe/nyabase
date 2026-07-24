const fixtures = new Set(['nfs']);
const actions = new Set(['stop', 'start', 'probe']);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

/** Closed failure vocabulary: callers cannot select containers, hosts, paths, or commands. */
export function validateStorageFixtureInput(value, expectedRunId) {
  invariant(
    value && typeof value === 'object' && !Array.isArray(value),
    'Storage fixture input must be an object',
  );
  invariant(
    JSON.stringify(Object.keys(value).sort())
      === JSON.stringify(['action', 'fixture', 'runId']),
    'Storage fixture input has unknown or missing fields',
  );
  invariant(value.runId === expectedRunId, 'Storage fixture operation run identity mismatch');
  invariant(fixtures.has(value.fixture), 'Invalid storage fixture');
  invariant(actions.has(value.action), 'Invalid storage fixture action');
  return value;
}
