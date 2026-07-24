import { describe, expect, it } from 'vitest';
import { requesterAgentTaskPath, requesterAgentTaskQueryKey } from './agent-task-scope.js';

describe('requester-scoped agent task reads', () => {
  it('never routes a mutation receipt through the capability-broader admin endpoint', () => {
    expect(requesterAgentTaskPath('task/id')).toBe('/agent-tasks/task%2Fid');
    expect(requesterAgentTaskPath('task/id')).not.toContain('/admin/agent-tasks');
    expect(requesterAgentTaskQueryKey('t1')).toEqual(['agent-task', 'user', 't1']);
  });
});
