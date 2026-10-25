/** Prefix of an auto-generated resource name: `ins` for containers, `vol` for volumes. */
export type DefaultNamePrefix = 'ins' | 'vol';

/** The date as `yymmdd` in local time: 2026-10-25 → "261025". */
export function dateStamp(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/**
 * A default name such as `ins-261025` that none of `taken` uses (compared
 * case-insensitively); collisions get `-2`, `-3`, … appended. The result is
 * lower-case ASCII letters, digits and hyphens, so it passes both the
 * container (`^[A-Za-z0-9][A-Za-z0-9-]*$`, ≤ 63) and the volume name rules.
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
