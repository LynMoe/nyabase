import { describe, expect, it } from 'vitest';
import { AgentTaskStatus } from '@nyabase/common';
import { ApiError } from './api-error.js';
import {
  agentTaskPollInterval,
  isAgentTaskQuerySettled,
} from '../hooks/use-agent-task-tracker.js';

describe('agent task query lifecycle', () => {
  it('settles and stops on terminal data or permanent lookup errors', () => {
    const failed = { status: AgentTaskStatus.Failed } as never;
    expect(isAgentTaskQuerySettled({ data: failed })).toBe(true);
    expect(agentTaskPollInterval({ data: failed })).toBe(false);

    for (const status of [403, 404]) {
      const error = new ApiError(status, 'TASK_UNAVAILABLE', 'unavailable');
      expect(isAgentTaskQuerySettled({ error })).toBe(true);
      expect(agentTaskPollInterval({ error })).toBe(false);
    }
  });

  it('keeps transient errors bounded and pending tasks active', () => {
    expect(agentTaskPollInterval({
      error: new ApiError(503, 'UNAVAILABLE', 'retry'),
      fetchFailureCount: 20,
    })).toBe(30_000);
    expect(agentTaskPollInterval({
      data: { status: AgentTaskStatus.Pending } as never,
    })).toBe(1_000);
  });
});
