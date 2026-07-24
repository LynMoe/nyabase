import { describe, expect, it } from 'vitest';
import { addTrackedTaskIds, retireTrackedTaskIds } from './tracked-task-ids.js';

describe('tracked task ID set', () => {
  it('retains concurrent A+B until each settled ID is retired', () => {
    const both = addTrackedTaskIds(['task-a'], ['task-b', 'task-a']);
    expect(both).toEqual(['task-a', 'task-b']);
    expect(retireTrackedTaskIds(both, ['task-a'])).toEqual(['task-b']);
    expect(retireTrackedTaskIds(both, ['task-b'])).toEqual(['task-a']);
  });
});
