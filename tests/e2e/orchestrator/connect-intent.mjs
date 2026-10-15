const RESOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function parseConnectIntentId(response) {
  const intentId = response?.intentId;
  if (
    typeof intentId !== 'string'
    || intentId.length < 1
    || intentId.length > 128
    || !RESOURCE_ID_RE.test(intentId)
  ) {
    throw new Error('BLOCKED: server connect response did not include a valid intent id');
  }
  return intentId;
}
