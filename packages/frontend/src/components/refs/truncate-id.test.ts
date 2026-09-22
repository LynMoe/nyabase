import { describe, expect, it } from 'vitest';
import { shortFingerprint, truncateId } from './truncate-id.js';

describe('truncateId', () => {
  it('keeps the first 8 characters of a UUID', () => {
    expect(truncateId('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400');
  });

  it('returns ids that are already short', () => {
    expect(truncateId('abc')).toBe('abc');
    expect(truncateId('12345678')).toBe('12345678');
    expect(truncateId('')).toBe('');
  });

  it('accepts a custom length', () => {
    expect(truncateId('abcdefghij', 4)).toBe('abcd');
  });
});

describe('shortFingerprint', () => {
  it('keeps the first 6 hex characters, lowercased', () => {
    expect(shortFingerprint('AB'.repeat(32))).toBe('ababab');
  });

  it('strips a sha256 prefix before slicing', () => {
    expect(shortFingerprint(`sha256:${'CD'.repeat(32)}`)).toBe('cdcdcd');
  });
});
