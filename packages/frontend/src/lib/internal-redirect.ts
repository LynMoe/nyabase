const INTERNAL_ORIGIN = 'https://nyabase.invalid';

/** Accept only same-origin absolute paths; never pass attacker-controlled URLs to navigation. */
export function sanitizeInternalRedirect(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string') return fallback;
  const candidate = value.trim();
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return fallback;
  if (/\p{Cc}/u.test(candidate)) return fallback;
  try {
    let decoded = candidate;
    for (let index = 0; index < 2; index += 1) decoded = decodeURIComponent(decoded);
    if (decoded.startsWith('//') || decoded.includes('\\')) return fallback;
    const parsed = new URL(candidate, INTERNAL_ORIGIN);
    if (parsed.origin !== INTERNAL_ORIGIN) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
