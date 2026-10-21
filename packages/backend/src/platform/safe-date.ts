import { ECMASCRIPT_DATE_MAX_EPOCH_MS } from '@nyabase/common';

/** Defensive projection for cached/legacy numeric timestamps. */
export function safeEpochToIso(value: unknown): string | null {
  if (
    !Number.isSafeInteger(value)
    || typeof value !== 'number'
    || value < 0
    || value > ECMASCRIPT_DATE_MAX_EPOCH_MS
  ) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
