import { CONTAINER_NAME_MAX_LENGTH } from '@nyabase/common';

/** Prefix of an auto-generated resource name: `ins` for containers without a usable default, `vol` for volumes. */
export type DefaultNamePrefix = 'ins' | 'vol';

/** The date as `yymmdd` in local time: 2026-10-25 → "261025". */
export function dateStamp(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/**
 * A default name such as `vol-261025` that none of `taken` uses (compared
 * case-insensitively); collisions get `-2`, `-3`, … appended. The result is
 * lower-case ASCII letters, digits and hyphens, so it passes the volume name rules.
 */
export function defaultResourceName(
  prefix: DefaultNamePrefix,
  taken: Iterable<string>,
  now: Date = new Date(),
): string {
  const used = new Set<string>();
  for (const name of taken) used.add(name.trim().toLowerCase());
  const base = `${prefix}-${dateStamp(now)}`;
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** `value` as container name parts: lower case, runs of anything else become one hyphen, none at the ends. */
function nameSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The first `length` characters, without leaving a hyphen at the end. */
function cut(value: string, length: number): string {
  return value.slice(0, Math.max(0, length)).replace(/-+$/, '');
}

/**
 * The default container name `<username>-<server>` (`admin-a800-4`), which none
 * of `taken` uses; collisions get `-2`, `-3`, … Server names may hold anything,
 * so both parts are reduced to what a container name allows. When it does not
 * fit, the username gives way first: the server is what tells the names apart.
 */
export function defaultContainerName(
  username: string,
  serverName: string,
  taken: Iterable<string>,
  now: Date = new Date(),
): string {
  const owner = nameSlug(username);
  const server = nameSlug(serverName);
  if (!owner && !server) return defaultResourceName('ins', taken, now);
  const used = new Set<string>();
  for (const name of taken) used.add(name.trim().toLowerCase());
  const fit = (length: number) => {
    const tail = cut(server, length);
    return [cut(owner, length - tail.length - 1), tail].filter(Boolean).join('-');
  };
  const base = fit(CONTAINER_NAME_MAX_LENGTH);
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${fit(CONTAINER_NAME_MAX_LENGTH - String(suffix).length - 1)}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
