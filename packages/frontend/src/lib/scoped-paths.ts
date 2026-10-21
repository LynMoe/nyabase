import type { ListScope } from '@nyabase/common';

/**
 * `path?scope=all&...` for list-style reads. `scope=mine` is the API default,
 * so it is left out and the URL stays what a plain user request looks like.
 */
export function scopedPath(
  path: string,
  scope: ListScope,
  query: Record<string, string | undefined> = {},
): string {
  const params = new URLSearchParams();
  if (scope === 'all') params.set('scope', 'all');
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value);
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}
