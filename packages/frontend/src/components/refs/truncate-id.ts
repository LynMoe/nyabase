const DEFAULT_LENGTH = 8;

/** Truncate a resource id for fallback labels. UUIDs become the first 8 hex chars. */
export function truncateId(id: string, length = DEFAULT_LENGTH): string {
  if (id.length <= length) return id;
  return id.slice(0, length);
}

/** Image fingerprints are 64 hex chars. There is no API short id. */
export function shortFingerprint(fingerprint: string, length = 6): string {
  const body = fingerprint.trim().toLowerCase().replace(/^sha256:/, '');
  return body.slice(0, length);
}

/** Folded opaque text: full value when it already fits, otherwise the first 8 chars plus an ellipsis. */
export function opaquePreview(value: string, length = DEFAULT_LENGTH): string {
  if (value.length <= length) return value;
  return `${truncateId(value, length)}…`;
}
