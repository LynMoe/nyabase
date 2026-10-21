import { describe, expect, it } from 'vitest';
import { FailureCode } from '@nyabase/common';
import { gpuErrorBody, parseMutatePciAddresses, parsePciAddressList } from './admit.js';

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return gpuErrorBody(error)?.code;
  }
  return undefined;
}

describe('parsePciAddressList', () => {
  it('canonicalizes valid addresses', () => {
    expect(parsePciAddressList(['0000:41:00.0'])).toEqual(['00000000:41:00.0']);
  });

  it('throws GPU_WILDCARD_FORBIDDEN for asterisk selectors', () => {
    expect(codeOf(() => parsePciAddressList(['0000:41:00.*']))).toBe(FailureCode.GpuWildcardForbidden);
  });

  it('throws GPU_DUPLICATE_PCI for aliases of the same card', () => {
    expect(codeOf(() => parsePciAddressList(['0000:41:00.0', '00000000:41:00.0'])))
      .toBe(FailureCode.GpuDuplicatePci);
  });

  it('throws GPU_INVALID_PCI for malformed addresses', () => {
    expect(codeOf(() => parsePciAddressList(['not-a-pci']))).toBe(FailureCode.GpuInvalidPci);
  });
});

describe('parseMutatePciAddresses', () => {
  it('accepts a strict pciAddresses body', () => {
    expect(parseMutatePciAddresses({ pciAddresses: ['0000:41:00.0'] })).toEqual(['00000000:41:00.0']);
  });

  it('surfaces the specific PCI error, or INVALID_INPUT for other shapes', () => {
    expect(codeOf(() => parseMutatePciAddresses({ pciAddresses: ['x'] }))).toBe(FailureCode.GpuInvalidPci);
    expect(codeOf(() => parseMutatePciAddresses({ other: 1 }))).toBe(FailureCode.InvalidInput);
  });
});
