import { useEffect, useMemo, useRef } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { AgentTaskStatus, type AgentTaskDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from './use-toast.js';

const TERMINAL = new Set<AgentTaskStatus>([
  AgentTaskStatus.Succeeded,
  AgentTaskStatus.Failed,
]);

export function isTerminalAgentTaskStatus(
  status: AgentTaskStatus | string | null | undefined,
): boolean {
  return Boolean(status && TERMINAL.has(status as AgentTaskStatus));
}

export function isPendingAgentTaskStatus(
  status: AgentTaskStatus | string | null | undefined,
): boolean {
  return status === AgentTaskStatus.Pending;
}

export function useAgentTaskTracker(
  taskId: string | null | undefined,
  options: { admin?: boolean } = {},
) {
  const qc = useQueryClient();
  const basePath = options.admin === true ? '/admin/agent-tasks' : '/agent-tasks';
  const query = useQuery({
    queryKey: ['agent-task', options.admin === true ? 'admin' : 'user', taskId],
    queryFn: () => api.get<AgentTaskDto>(`${basePath}/${taskId}`),
    enabled: Boolean(taskId),
    refetchInterval: (state) => (
      isTerminalAgentTaskStatus(state.state.data?.status) ? false : 1000
    ),
  });

  useEffect(() => {
    if (isTerminalAgentTaskStatus(query.data?.status)) {
      void qc.invalidateQueries({
        queryKey: options.admin === true ? queryKeys.containers.adminList : queryKeys.containers.userList,
      });
      void qc.invalidateQueries({ queryKey: ['container', options.admin === true ? 'admin' : 'user'] });
    }
  }, [query.data?.status, qc, options.admin]);

  return query;
}

export function useAgentTaskBatchTracker(
  taskIds: readonly string[],
  options: { admin?: boolean } = {},
) {
  const qc = useQueryClient();
  const ids = useMemo(() => [...new Set(taskIds.filter(Boolean))], [taskIds]);
  const basePath = options.admin === true ? '/admin/agent-tasks' : '/agent-tasks';
  const queries = useQueries({
    queries: ids.map((taskId) => ({
      queryKey: ['agent-task', options.admin === true ? 'admin' : 'user', taskId],
      queryFn: () => api.get<AgentTaskDto>(`${basePath}/${taskId}`),
      refetchInterval: (state: { state: { data?: AgentTaskDto } }) => (
        isTerminalAgentTaskStatus(state.state.data?.status) ? false : 1000
      ),
    })),
  });
  const tasks = queries.flatMap((query) => query.data ? [query.data] : []);
  const allTerminal = ids.length > 0
    && queries.length === ids.length
    && queries.every((query) => isTerminalAgentTaskStatus(query.data?.status));
  const failed = tasks.filter((task) => task.status === AgentTaskStatus.Failed);

  useEffect(() => {
    if (!allTerminal) return;
    void qc.invalidateQueries({ queryKey: queryKeys.containers.adminList });
    void qc.invalidateQueries({ queryKey: ['container', 'admin'] });
  }, [allTerminal, qc]);

  return { ids, tasks, allTerminal, failed };
}

/** Keep the admin UI attached to every physical task returned by a mutation. */
export function useAdminAgentTaskBatchFeedback(taskIds: readonly string[]) {
  const tracker = useAgentTaskBatchTracker(taskIds, { admin: true });
  const notifiedIds = useRef(new Set<string>());
  const pendingIds = tracker.ids.filter((taskId) => !notifiedIds.current.has(taskId));
  const pendingIdSet = new Set(pendingIds);
  const pendingTasks = tracker.tasks.filter((task) => pendingIdSet.has(task.id));
  const pendingFailed = pendingTasks.filter((task) => task.status === AgentTaskStatus.Failed);
  const pendingAllTerminal = pendingIds.length > 0
    && pendingTasks.length === pendingIds.length
    && pendingTasks.every((task) => isTerminalAgentTaskStatus(task.status));
  const batchKey = pendingIds.join(',');

  useEffect(() => {
    if (!pendingAllTerminal || !batchKey) return;
    pendingIds.forEach((taskId) => notifiedIds.current.add(taskId));
    if (pendingFailed.length > 0) {
      const details = pendingFailed
        .map((task) => `${task.id.slice(0, 8)}: ${formatTaskError(task.error)}`)
        .join('；');
      toast({ title: '宿主任务失败', description: details, variant: 'destructive' });
      return;
    }
    toast({
      title: '宿主任务已完成',
      description: `${pendingTasks.length} 个任务均已成功`,
    });
  }, [batchKey, pendingAllTerminal, pendingFailed, pendingIds, pendingTasks.length]);

  return tracker;
}

function formatTaskError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    try {
      return JSON.stringify(error);
    } catch {
      return '未知错误';
    }
  }
  return '未知错误';
}
