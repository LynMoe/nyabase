import { describe, expect, it } from 'vitest';
import { NVIDIA_GPU_EXTENSION_ID } from './id.js';
import { formatGrantSummary } from './grant-state.js';

describe('formatGrantSummary', () => {
  it('omits missing grants and empty pci lists', () => {
    expect(formatGrantSummary(undefined)).toBeNull();
    expect(formatGrantSummary({})).toBeNull();
    expect(formatGrantSummary({
      [NVIDIA_GPU_EXTENSION_ID]: { pciAddresses: [] },
    })).toBeNull();
    expect(formatGrantSummary({
      [NVIDIA_GPU_EXTENSION_ID]: { mode: 'all', pciAddresses: [] },
    })).toBeNull();
  });

  it('renders the granted card count', () => {
    expect(formatGrantSummary({
      [NVIDIA_GPU_EXTENSION_ID]: {
        pciAddresses: ['00000000:41:00.0', '00000000:a1:00.0'],
      },
    })).toBe('2GPU');
  });
});
