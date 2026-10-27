/**
 * Names users see in a terminal prompt (`root@web-01 [aya-1] ~#`): container
 * names stay host-name shaped (`ssh <name>.<suffix>`), server names may use
 * any visible characters. Both are bounded in terminal columns, not code units.
 */

/** Container names: ASCII letters, digits and hyphens, not starting with a hyphen. */
export const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
export const CONTAINER_NAME_MAX_LENGTH = 16;
/** Terminal columns a server name may take (a CJK character takes two). */
export const SERVER_NAME_MAX_WIDTH = 32;

/** Letters, marks, digits, punctuation, symbols and the plain space; no controls or invisible formatting. */
const VISIBLE_NAME_RE = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u;
/** Letters and symbols that render as blank: Hangul fillers and the empty Braille pattern. */
const BLANK_CHARACTER_RE = /[\u115f\u1160\u3164\uffa0\u2800]/u;
const ZERO_WIDTH_RE = /^[\p{Mn}\p{Me}]$/u;

/** East Asian Width W/F ranges (CJK, Hangul, kana, fullwidth forms, emoji). */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0],
  [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5],
  [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18cff], [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function isWide(codePoint: number): boolean {
  let low = 0;
  let high = WIDE_RANGES.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = WIDE_RANGES[middle]!;
    if (codePoint < start) high = middle - 1;
    else if (codePoint > end) low = middle + 1;
    else return true;
  }
  return false;
}

/** Terminal columns `value` takes: 2 per wide character, 0 per combining mark, 1 otherwise. */
export function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    if (ZERO_WIDTH_RE.test(character)) continue;
    width += isWide(character.codePointAt(0)!) ? 2 : 1;
  }
  return width;
}

/** Why `name` (already trimmed) cannot be a server name, or null when it can. */
export function serverNameProblem(name: string): string | null {
  return visibleNameProblem(name, 'Server name', SERVER_NAME_MAX_WIDTH);
}

/** Why `name` (already trimmed) is not a non-empty visible name of at most `maxWidth` columns. */
export function visibleNameProblem(name: string, label: string, maxWidth: number): string | null {
  if (name.length === 0) return `${label} is required`;
  if (!VISIBLE_NAME_RE.test(name) || BLANK_CHARACTER_RE.test(name)) return `${label} may only contain visible characters and spaces`;
  if (displayWidth(name) > maxWidth) {
    return `${label} may take at most ${maxWidth} columns (CJK characters count as 2)`;
  }
  return null;
}
