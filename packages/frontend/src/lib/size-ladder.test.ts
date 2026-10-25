import { describe, expect, it } from 'vitest';
import {
  clampToAvailable,
  fallbackMaxGib,
  formatSizeValue,
  formatTickLabel,
  gibInputText,
  labelIndices,
  positionOf,
  positionPercent,
  sizeScale,
  stepStop,
} from './size-ladder.js';

describe('sizeScale', () => {
  it('truncates the ladder at the max and always ends on the max', () => {
    expect(sizeScale('memory', 16).stops).toEqual([0.5, 1, 2, 3, 4, 6, 8, 12, 16]);
    expect(sizeScale('memory', 20).stops).toEqual([0.5, 1, 2, 3, 4, 6, 8, 12, 16, 20]);
    expect(sizeScale('disk', 120).stops).toEqual([5, 10, 20, 30, 40, 50, 80, 100, 120]);
    expect(sizeScale('volume', 10).stops).toEqual([1, 2, 5, 10]);
  });

  it('labels the max even when it is not a ladder major', () => {
    expect(sizeScale('memory', 20).majors.has(20)).toBe(true);
  });

  it('falls back to the kind default when the max is unknown', () => {
    expect(sizeScale('memory', null).stops.at(-1)).toBe(fallbackMaxGib('memory'));
    expect(sizeScale('disk', 0).stops.at(-1)).toBe(4096);
    expect(sizeScale('disk', Number.NaN).stops.at(-1)).toBe(4096);
  });

  it('keeps two stops for a range below the first rung', () => {
    expect(sizeScale('memory', 0.25).stops).toEqual([0.125, 0.25]);
    expect(sizeScale('disk', 3).stops).toEqual([1.5, 3]);
  });

  it('tidies a fractional max to three decimals', () => {
    expect(sizeScale('memory', 15.73456).stops.at(-1)).toBe(15.735);
  });
});

describe('positionOf', () => {
  const stops = [1, 2, 4, 8];

  it('puts stops on whole indices', () => {
    expect(positionOf(stops, 1)).toBe(0);
    expect(positionOf(stops, 4)).toBe(2);
    expect(positionOf(stops, 8)).toBe(3);
  });

  it('places a value between stops proportionally', () => {
    expect(positionOf(stops, 3)).toBe(1.5);
    expect(positionOf(stops, 5)).toBe(2.25);
  });

  it('clamps outside values to the ends', () => {
    expect(positionOf(stops, 0.5)).toBe(0);
    expect(positionOf(stops, 100)).toBe(3);
    expect(positionOf(stops, Number.NaN)).toBe(0);
  });

  it('converts to a track percentage', () => {
    expect(positionPercent(stops, 4)).toBeCloseTo(66.667, 2);
    expect(positionPercent([2], 2)).toBe(0);
  });
});

describe('stepStop', () => {
  const stops = [1, 2, 4, 8];

  it('moves to the neighbouring stop', () => {
    expect(stepStop(stops, 2, 1)).toBe(4);
    expect(stepStop(stops, 2, -1)).toBe(1);
  });

  it('moves a value between stops to the nearest stop in that direction', () => {
    expect(stepStop(stops, 3, 1)).toBe(4);
    expect(stepStop(stops, 3, -1)).toBe(2);
  });

  it('stops at the ends and supports multi-step jumps', () => {
    expect(stepStop(stops, 8, 1)).toBe(8);
    expect(stepStop(stops, 1, -1)).toBe(1);
    expect(stepStop(stops, 1, 1, 10)).toBe(8);
  });
});

describe('clampToAvailable', () => {
  it('leaves values within what is left alone', () => {
    expect(clampToAvailable(8, 12)).toBe(8);
    expect(clampToAvailable(8, null)).toBe(8);
  });

  it('rounds the clamp down so it never exceeds what is left', () => {
    expect(clampToAvailable(16, 12.349)).toBe(12.34);
  });

  it('keeps the value when nothing is left to clamp to', () => {
    expect(clampToAvailable(4, 0)).toBe(4);
  });
});

describe('labelIndices', () => {
  const scale = sizeScale('memory', 64);

  it('labels the first stop, majors and the max when there is room', () => {
    const labels = labelIndices(scale, 1).map((index) => scale.stops[index]);
    expect(labels).toEqual([0.5, 1, 2, 4, 8, 16, 32, 64]);
  });

  it('thins labels on a narrow track but keeps the max', () => {
    const labels = labelIndices(scale, 4).map((index) => scale.stops[index]);
    expect(labels.at(-1)).toBe(64);
    const indices = labelIndices(scale, 4);
    for (let i = 1; i < indices.length; i += 1) expect(indices[i]! - indices[i - 1]!).toBeGreaterThanOrEqual(4);
  });
});

describe('formatting', () => {
  it('formats tick labels compactly', () => {
    expect(formatTickLabel(0.5)).toBe('512M');
    expect(formatTickLabel(8)).toBe('8G');
    expect(formatTickLabel(1024)).toBe('1T');
    expect(formatTickLabel(1536)).toBe('1.5T');
  });

  it('formats the selected value with units', () => {
    expect(formatSizeValue(0.5)).toBe('512 MiB');
    expect(formatSizeValue(8)).toBe('8 GiB');
    expect(formatSizeValue(12.345)).toBe('12.35 GiB');
    expect(formatSizeValue(2048)).toBe('2 TiB');
  });

  it('writes input text without float noise', () => {
    expect(gibInputText(0.1 + 0.2)).toBe('0.3');
    expect(gibInputText(16)).toBe('16');
  });
});
