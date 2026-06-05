import type { ValueTransformer } from 'typeorm';

export const numericTextTransformer: ValueTransformer = {
  to: (value: number): string => String(value ?? 0),
  from: (value: string | number | null): number => {
    if (typeof value === 'number') return value;
    return parseInt(value ?? '0', 10);
  },
};

export const nullableNumericTextTransformer: ValueTransformer = {
  to: (value: number | null): string | null => (value == null ? null : String(value)),
  from: (value: string | number | null): number | null => {
    if (value == null) return null;
    if (typeof value === 'number') return value;
    return parseInt(value, 10);
  },
};

export const numberArrayTextTransformer: ValueTransformer = {
  to: (value: number[]): string => JSON.stringify(Array.isArray(value) ? value : []),
  from: (value: string | number[] | null): number[] => {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    try {
      return JSON.parse(value) as number[];
    } catch {
      return [];
    }
  },
};
