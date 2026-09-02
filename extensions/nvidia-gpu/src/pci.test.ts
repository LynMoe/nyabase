import { describe, expect, it } from 'vitest';
import { canonicalPciAddress, isWildcardPciAddress, toIncusPciAddress } from './pci.js';

describe('canonicalPciAddress', () => {
  it('pads 4-hex domains to 8-hex lowercase', () => {
    expect(canonicalPciAddress('0000:41:00.0')).toBe('00000000:41:00.0');
    expect(canonicalPciAddress('0000:A1:00.0')).toBe('00000000:a1:00.0');
    expect(canonicalPciAddress('00000000:41:00.0')).toBe('00000000:41:00.0');
  });

  it('rejects malformed and wildcard selectors', () => {
    expect(canonicalPciAddress('41:00.0')).toBeNull();
    expect(canonicalPciAddress('0000:41:00.*')).toBeNull();
    expect(canonicalPciAddress('*')).toBeNull();
    expect(canonicalPciAddress('not-a-pci')).toBeNull();
  });
});

describe('toIncusPciAddress', () => {
  it('emits 4-hex sysfs domains', () => {
    expect(toIncusPciAddress('00000000:41:00.0')).toBe('0000:41:00.0');
    expect(toIncusPciAddress('00000000:a1:00.0')).toBe('0000:a1:00.0');
  });
});

describe('isWildcardPciAddress', () => {
  it('detects asterisk selectors', () => {
    expect(isWildcardPciAddress('0000:41:00.*')).toBe(true);
    expect(isWildcardPciAddress('*')).toBe(true);
    expect(isWildcardPciAddress('0000:41:00.0')).toBe(false);
  });
});
