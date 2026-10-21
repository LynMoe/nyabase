const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function containsTrustToken(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsTrustToken);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => {
    if (key === 'trustTokenRef') return false;
    const normalizedKey = key.replaceAll('_', '').replaceAll('-', '').toLowerCase();
    if (normalizedKey === 'token' || normalizedKey.includes('trusttoken')) return true;
    return containsTrustToken(child);
  });
}

/**
 * A server.connect intent is persisted and shown in history, so it may only
 * carry an opaque reference to the one-time trust token, never the token.
 */
export function assertPersistableConnectRequest(request: Record<string, unknown>): void {
  const reference = request.trustTokenRef;
  if (typeof reference !== 'string' || !UUID_RE.test(reference)) {
    throw new Error('Server connect intents require a persistable trust-token reference');
  }
  if (containsTrustToken(request)) {
    throw new Error('Server connect intents cannot persist a trust token');
  }
}
