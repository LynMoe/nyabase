import { describe, expect, it } from 'vitest';
import { createResourceMutationGate } from './resource-mutation-gate.js';

describe('resource mutation gate', () => {
  it('serializes one resource without blocking another', () => {
    const gate = createResourceMutationGate();
    expect(gate.begin('image-a')).toBe(true);
    expect(gate.begin('image-a')).toBe(false);
    expect(gate.begin('image-b')).toBe(true);
    gate.end('image-a');
    expect(gate.begin('image-a')).toBe(true);
    expect([...gate.snapshot()].sort()).toEqual(['image-a', 'image-b']);
  });
});
