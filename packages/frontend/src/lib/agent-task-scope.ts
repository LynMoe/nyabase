export function requesterAgentTaskPath(taskId: string): string {
  return `/agent-tasks/${encodeURIComponent(taskId)}`;
}

export function requesterAgentTaskQueryKey(taskId: string): readonly ['agent-task', 'user', string] {
  return ['agent-task', 'user', taskId] as const;
}
