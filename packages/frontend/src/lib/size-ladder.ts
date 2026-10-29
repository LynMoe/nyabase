/**
 * Non-linear "nice" size scales for the size sliders. A slider moves over
 * stop indices, so every stop is equally far apart on the track while the
 * values grow roughly geometrically. All sizes here are in GiB.
 */

/** Which ladder a slider uses: container memory, container root disk, or a data volume. */
export type SizeScaleKind = 'memory' | 'disk' | 'volume';

export interface SizeScale {
  /** Ascending stop values (GiB); the last one is always the range max. */
  stops: number[];
  /** Stop values that may carry a tick label. */
  majors: ReadonlySet<number>;
  /** Whether the max is a real bound (a grant, the host, free space) rather than the kind's fallback. */
  bounded: boolean;
  /** The most a create form defaults to (1 TiB memory, 20 TiB disk), however large the range. */
  defaultCap: number;
}

const TIB = 1024;

const MEMORY_LADDER = [0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096];
const MEMORY_MAJORS = [0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];

const DISK_TAIL = [
  5, 10, 20, 30, 40, 50, 80, 100, 150, 200, 300, 500, 750,
  TIB, 1.5 * TIB, 2 * TIB, 3 * TIB, 4 * TIB, 6 * TIB, 8 * TIB, 12 * TIB, 16 * TIB, 24 * TIB, 32 * TIB, 48 * TIB, 64 * TIB,
];
const DISK_MAJORS = [10, 20, 50, 100, 200, 500, TIB, 2 * TIB, 4 * TIB, 8 * TIB, 16 * TIB, 32 * TIB, 64 * TIB];

/** `defaultCap`: a create form never fills in more than this on its own (an overcommitted backend's range can be huge). */
const LADDERS: Record<SizeScaleKind, { ladder: number[]; majors: number[]; fallbackMax: number; defaultCap: number }> = {
  memory: { ladder: MEMORY_LADDER, majors: MEMORY_MAJORS, fallbackMax: 512, defaultCap: TIB },
  disk: { ladder: DISK_TAIL, majors: DISK_MAJORS, fallbackMax: 4 * TIB, defaultCap: 20 * TIB },
  volume: { ladder: [1, 2, ...DISK_TAIL], majors: [1, 2, 5, ...DISK_MAJORS], fallbackMax: 4 * TIB, defaultCap: 20 * TIB },
};

/** The fallback range max of a kind when nothing bounds it (512 GiB memory, 4 TiB disk). */
export function fallbackMaxGib(kind: SizeScaleKind): number {
  return LADDERS[kind].fallbackMax;
}

/** Rounds to at most 3 decimals so stops and typed text stay readable. */
function tidy(gib: number): number {
  return Math.round(gib * 1000) / 1000;
}

/**
 * The ladder of `kind` truncated at `maxGib`; the max itself is always the
 * last stop. A non-positive or unknown max falls back to the kind's default.
 */
export function sizeScale(kind: SizeScaleKind, maxGib: number | null): SizeScale {
  const { ladder, majors, fallbackMax, defaultCap } = LADDERS[kind];
  const bounded = maxGib !== null && Number.isFinite(maxGib) && maxGib > 0;
  const max = bounded ? tidy(maxGib) : fallbackMax;
  const stops = ladder.filter((value) => value < max);
  stops.push(max);
  // A range smaller than the first rung still needs two stops to slide between.
  if (stops.length === 1) stops.unshift(tidy(max / 2));
  return { stops, majors: new Set([...majors, max]), bounded, defaultCap };
}

/** Fractional stop index of `value`, interpolated between neighbouring stops and clamped to the track. */
export function positionOf(stops: readonly number[], value: number): number {
  const last = stops.length - 1;
  if (last < 0) return 0;
  if (!Number.isFinite(value) || value <= stops[0]!) return 0;
  if (value >= stops[last]!) return last;
  let index = 0;
  while (index < last && stops[index + 1]! <= value) index += 1;
  const low = stops[index]!;
  const high = stops[index + 1]!;
  return index + (value - low) / (high - low);
}

/** The track position as a percentage (0–100) of its length. */
export function positionPercent(stops: readonly number[], value: number): number {
  const last = stops.length - 1;
  return last <= 0 ? 0 : (positionOf(stops, value) / last) * 100;
}

/**
 * The value one keyboard step (or `count` steps) away: the next stop strictly
 * above or below `value`, so a typed value between stops moves to a neighbour.
 */
export function stepStop(stops: readonly number[], value: number, direction: 1 | -1, count = 1): number {
  if (stops.length === 0) return value;
  let current = value;
  for (let step = 0; step < count; step += 1) {
    const next = direction > 0
      ? stops.find((stop) => stop > current + 1e-9)
      : [...stops].reverse().find((stop) => stop < current - 1e-9);
    if (next === undefined) break;
    current = next;
  }
  return current;
}

/**
 * Keeps a slider-chosen value within what is left. `availableGib` null means
 * unlimited; the clamp rounds down to 0.01 GiB so the result never exceeds it.
 */
export function clampToAvailable(value: number, availableGib: number | null): number {
  if (availableGib === null || value <= availableGib) return value;
  const floored = Math.floor(availableGib * 100) / 100;
  return floored > 0 ? floored : value;
}

/**
 * A form default that fits what is left: the default itself when it fits (or
 * nothing limits it), otherwise the largest stop within `availableGib`, or the
 * plain clamp when even the smallest stop is too big.
 */
export function fitDefault(stops: readonly number[], defaultGib: number, availableGib: number | null): number {
  if (availableGib === null || defaultGib <= availableGib) return defaultGib;
  const fitting = stops.filter((stop) => stop <= availableGib);
  return fitting.length > 0 ? fitting[fitting.length - 1]! : clampToAvailable(defaultGib, availableGib);
}

/**
 * A create form's default size: the most it can choose (the range max, within
 * what is left, never above the kind's `defaultCap`) when the range is bounded,
 * otherwise `fallbackGib` fitted to what is left, so an unknown or unbounded
 * range never defaults to its ladder end.
 */
export function maxDefault(scale: SizeScale, fallbackGib: number, availableGib: number | null): number {
  if (!scale.bounded) return fitDefault(scale.stops, fallbackGib, availableGib);
  return clampToAvailable(Math.min(scale.stops[scale.stops.length - 1]!, scale.defaultCap), availableGib);
}

/**
 * Indices of the stops that get a tick label: the max always, the first stop
 * and majors when they are at least `minGap` stops from an already labelled
 * one (chosen from the max downward so the max never loses its label).
 */
export function labelIndices(scale: SizeScale, minGap: number): number[] {
  const { stops, majors } = scale;
  const last = stops.length - 1;
  if (last < 0) return [];
  const gap = Math.max(1, Math.ceil(minGap));
  const chosen = [last];
  for (let index = last - 1; index >= 0; index -= 1) {
    if (index !== 0 && !majors.has(stops[index]!)) continue;
    if (chosen[chosen.length - 1]! - index >= gap) chosen.push(index);
  }
  return chosen.reverse();
}

function trimNumber(value: number, decimals: number): string {
  return parseFloat(value.toFixed(decimals)).toString();
}

/** Compact tick label: 0.5 → "512M", 8 → "8G", 1536 → "1.5T". */
export function formatTickLabel(gib: number): string {
  if (gib < 1) return `${Math.round(gib * 1024)}M`;
  if (gib >= TIB) return `${trimNumber(gib / TIB, 1)}T`;
  return `${trimNumber(gib, 1)}G`;
}

/** The selected size for display: "512 MiB", "8 GiB", "1.5 TiB". */
export function formatSizeValue(gib: number): string {
  if (gib < 1) return `${Math.round(gib * 1024)} MiB`;
  if (gib >= TIB) return `${trimNumber(gib / TIB, 2)} TiB`;
  return `${trimNumber(gib, 2)} GiB`;
}

/** The text a slider writes into the GiB input. */
export function gibInputText(gib: number): string {
  return trimNumber(gib, 3);
}
