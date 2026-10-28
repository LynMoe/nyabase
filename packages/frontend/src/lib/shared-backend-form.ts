/**
 * The per-user volume cap input of a shared backend: '' → null (不限); a
 * whole number ≥ 1 → that cap; anything else → undefined (invalid).
 */
export function parseMaxVolumesPerUser(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 1 && value <= 10_000 ? value : undefined;
}

export function maxVolumesPerUserLabel(limit: number | null): string {
  return limit === null ? '不限' : `${limit} 个`;
}
