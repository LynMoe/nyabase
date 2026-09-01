import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createResourceMutationGate,
  resetResourceMutationGateForTests,
  resourceMutationGate,
  runGatedMutation,
} from './resource-mutation-gate.js';

afterEach(() => {
  resetResourceMutationGateForTests();
});

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

  it('notifies subscribers on begin and end', () => {
    const listener = vi.fn();
    const unsubscribe = resourceMutationGate.subscribe(listener);
    expect(resourceMutationGate.begin('a')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    resourceMutationGate.end('a');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(resourceMutationGate.begin('a')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not notify when begin is rejected', () => {
    expect(resourceMutationGate.begin('a')).toBe(true);
    const listener = vi.fn();
    resourceMutationGate.subscribe(listener);
    expect(resourceMutationGate.begin('a')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('reset clears pending and listeners', () => {
    const listener = vi.fn();
    resourceMutationGate.subscribe(listener);
    expect(resourceMutationGate.begin('a')).toBe(true);
    listener.mockClear();
    resetResourceMutationGateForTests();
    expect(resourceMutationGate.has('a')).toBe(false);
    expect(resourceMutationGate.snapshot().size).toBe(0);
    expect(resourceMutationGate.begin('b')).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('runGatedMutation', () => {
  it('returns false without running fn when the gate is held', async () => {
    expect(resourceMutationGate.begin('a')).toBe(true);
    const fn = vi.fn(async () => undefined);
    expect(await runGatedMutation('a', fn)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('ends the gate in finally when fn throws', async () => {
    await expect(
      runGatedMutation('a', async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(resourceMutationGate.has('a')).toBe(false);
    expect(await runGatedMutation('a', async () => undefined)).toBe(true);
  });

  it('returns true after a successful mutation', async () => {
    expect(await runGatedMutation('a', async () => undefined)).toBe(true);
    expect(resourceMutationGate.has('a')).toBe(false);
  });
});
