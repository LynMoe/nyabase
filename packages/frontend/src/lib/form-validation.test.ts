import { describe, expect, it } from 'vitest';
import { parseGroupPriority } from './form-validation.js';

describe('parseGroupPriority', () => {
  it('preserves zero and applies the create default only to blank input', () => {
    expect(parseGroupPriority('0', 10)).toBe(0);
    expect(parseGroupPriority('', 10)).toBe(10);
  });

  it.each(['1.5', '-1', '1e30', 'not-a-number'])('rejects invalid priority %s', (value) => {
    expect(() => parseGroupPriority(value)).toThrow();
  });
});
