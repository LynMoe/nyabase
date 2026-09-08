const DEFAULT_LENGTH = 8;

/** Truncate a resource id for fallback labels. UUIDs become the first 8 hex chars. */
export function truncateId(id: string, length = DEFAULT_LENGTH): string {
  if (id.length <= length) return id;
  return id.slice(0, length);
}
