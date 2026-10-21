import { describe, expect, it } from 'vitest';
import { formatGpuGrantSummary } from './grant-state.js';

describe('formatGpuGrantSummary', () => {
  it('omits missing grants and empty pci lists', () => {
    expect(formatGpuGrantSummary(undefined)).toBeNull();
    expect(formatGpuGrantSummary(null)).toBeNull();
    expect(formatGpuGrantSummary([])).toBeNull();
  });

  it('renders the granted card count', () => {
    expect(formatGpuGrantSummary(['00000000:41:00.0', '00000000:a1:00.0'])).toBe('2 张 GPU');
  });
});
