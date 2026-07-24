import { useEffect, useMemo, useRef } from 'react';
import { useQueries, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { AgentTaskStatus, type AgentTaskDto, type UserAgentTaskDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from './use-toast.js';
import { isPermanentQueryError, queryPollInterval } from '../lib/query-lifecycle.js';

const TERMINAL = new Set<AgentTaskStatus>([
  AgentTaskStatus.Succeeded,
  AgentTaskStatus.Failed,
]);

type TaskProgressDto = AgentTaskDto | UserAgentTaskDto;

export interface AgentTaskTrackerOptions {
  admin?: boolean;
  invalidateQueryKeys?: readonly QueryKey[];
}

export interface AgentTaskFeedbackOptions extends Omit<AgentTaskTrackerOptions, 'admin'> {
  onSettledTaskIds?: (taskIds: readonly string[]) => void;
}

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

export function agentTaskPollInterval(state: {
  data?: TaskProgressDto;
  error?: unknown;
  fetchFailureCount?: number;
}): number | false {
  return queryPollInterval(state, {
    activeIntervalMs: 1_000,
    transientBaseIntervalMs: 2_000,
    transientMaxIntervalMs: 30_000,
    isTerminal: (task) => isTerminalAgentTaskStatus(task.status),
  });
}

export function isAgentTaskQuerySettled(state: {
  data?: TaskProgressDto;
  error?: unknown;
}): boolean {
  return isTerminalAgentTaskStatus(state.data?.status) || isPermanentQueryError(state.error);
}

export function useAgentTaskTracker(
  taskId: string | null | undefined,
  options: AgentTaskTrackerOptions = {},
) {
  const qc = useQueryClient();
  const invalidatedTaskIds = useRef(new Set<string>());
  const notifiedErrors = useRef(new Set<string>());
  const basePath = options.admin === true ? '/admin/agent-tasks' : '/agent-tasks';
  const query = useQuery({
    queryKey: ['agent-task', options.admin === true ? 'admin' : 'user', taskId],
    queryFn: () => api.get<TaskProgressDto>(`${basePath}/${taskId}`),
    enabled: Boolean(taskId),
    refetchInterval: (state) => agentTaskPollInterval(state.state),
  });

  useEffect(() => {
    if (!taskId || !isTerminalAgentTaskStatus(query.data?.status)
      || invalidatedTaskIds.current.has(taskId)) return;
    invalidatedTaskIds.current.add(taskId);
    invalidateTrackedResources(qc, options);
    if (query.data?.status === AgentTaskStatus.Failed) {
      toast({
        title: '宿主任务失败',
        description: formatTaskError(query.data.error),
        variant: 'destructive',
      });
    }
  }, [taskId, query.data, qc, options]);

  useEffect(() => {
    if (!taskId || !isPermanentQueryError(query.error) || notifiedErrors.current.has(taskId)) return;
    notifiedErrors.current.add(taskId);
    invalidateTrackedResources(qc, options);
    toast({
      title: '任务跟踪已停止',
      description: query.error instanceof Error ? query.error.message : '任务已不可读取，请刷新资源状态',
      variant: 'destructive',
    });
  }, [taskId, query.error, qc, options]);

  return query;
}

export function useAgentTaskBatchTracker(
  taskIds: readonly string[],
  options: AgentTaskTrackerOptions = {},
) {
  const qc = useQueryClient();
  const invalidatedBatches = useRef(new Set<string>());
  const ids = useMemo(() => [...new Set(taskIds.filter(Boolean))], [taskIds]);
  const basePath = options.admin === true ? '/admin/agent-tasks' : '/agent-tasks';
  const queries = useQueries({
    queries: ids.map((taskId) => ({
      queryKey: ['agent-task', options.admin === true ? 'admin' : 'user', taskId],
      queryFn: () => api.get<TaskProgressDto>(`${basePath}/${taskId}`),
      refetchInterval: (state: { state: { data?: TaskProgressDto; error?: unknown; fetchFailureCount?: number } }) =>
        agentTaskPollInterval(state.state),
    })),
  });
  const tasks = queries.flatMap((query) => query.data ? [query.data] : []);
  const permanentErrors = queries.flatMap((query, index) => isPermanentQueryError(query.error)
    ? [{ taskId: ids[index]!, error: query.error }]
    : []);
  const allSettled = ids.length > 0
    && queries.length === ids.length
    && queries.every((query) => isAgentTaskQuerySettled(query));
  const failed = tasks.filter((task) => task.status === AgentTaskStatus.Failed);
  const batchKey = ids.join(',');

  useEffect(() => {
    if (!allSettled || !batchKey || invalidatedBatches.current.has(batchKey)) return;
    invalidatedBatches.current.add(batchKey);
    invalidateTrackedResources(qc, options);
  }, [allSettled, batchKey, qc, options]);

  return {
    ids,
    tasks,
    allSettled,
    // Compatibility for existing consumers: permanently unreadable is also a
    // settled tracking outcome and must trigger final resource invalidation.
    allTerminal: allSettled,
    failed,
    permanentErrors,
  };
}

/** Keep the admin UI attached to every physical task returned by a mutation. */
export function useAdminAgentTaskBatchFeedback(
  taskIds: readonly string[],
  options: AgentTaskFeedbackOptions = {},
) {
  return useAgentTaskBatchFeedback(taskIds, { ...options, admin: true });
}

/** Track only tasks created by the current principal through requester-scoped endpoints. */
export function useRequesterAgentTaskBatchFeedback(
  taskIds: readonly string[],
  options: AgentTaskFeedbackOptions = {},
) {
  return useAgentTaskBatchFeedback(taskIds, options);
}

function useAgentTaskBatchFeedback(
  taskIds: readonly string[],
  options: AgentTaskFeedbackOptions & { admin?: boolean } = {},
) {
  const { onSettledTaskIds, ...trackerOptions } = options;
  const tracker = useAgentTaskBatchTracker(taskIds, trackerOptions);
  const notifiedIds = useRef(new Set<string>());
  const pendingIds = tracker.ids.filter((taskId) => !notifiedIds.current.has(taskId));
  const pendingIdSet = new Set(pendingIds);
  const pendingTasks = tracker.tasks.filter((task) => pendingIdSet.has(task.id));
  const pendingFailed = pendingTasks.filter((task) => task.status === AgentTaskStatus.Failed);
  const pendingPermanentErrors = tracker.permanentErrors.filter(({ taskId }) => pendingIdSet.has(taskId));
  const pendingSettledCount = pendingTasks.filter((task) => isTerminalAgentTaskStatus(task.status)).length
    + pendingPermanentErrors.length;
  const pendingAllTerminal = pendingIds.length > 0 && pendingSettledCount === pendingIds.length;
  const batchKey = pendingIds.join(',');

  useEffect(() => {
    if (!pendingAllTerminal || !batchKey) return;
    pendingIds.forEach((taskId) => notifiedIds.current.add(taskId));
    onSettledTaskIds?.(pendingIds);
    if (pendingFailed.length > 0 || pendingPermanentErrors.length > 0) {
      const taskDetails = pendingFailed
        .map((task) => `${task.id.slice(0, 8)}: ${formatTaskError(task.error)}`)
      const trackingDetails = pendingPermanentErrors.map(({ taskId, error }) =>
        `${taskId.slice(0, 8)}: ${error instanceof Error ? error.message : '任务不可读取'}`);
      toast({
        title: pendingFailed.length > 0 ? '宿主任务失败' : '任务跟踪已停止',
        description: [...taskDetails, ...trackingDetails].join('；'),
        variant: 'destructive',
      });
      return;
    }
    toast({
      title: '宿主任务已完成',
      description: `${pendingTasks.length} 个任务均已成功`,
    });
  }, [batchKey, onSettledTaskIds, pendingAllTerminal, pendingFailed, pendingIds, pendingPermanentErrors, pendingTasks.length]);

  return tracker;
}

function invalidateTrackedResources(
  qc: ReturnType<typeof useQueryClient>,
  options: AgentTaskTrackerOptions,
): void {
  const defaults: readonly QueryKey[] = [
    options.admin === true ? queryKeys.containers.adminList : queryKeys.containers.userList,
    ['container', options.admin === true ? 'admin' : 'user'],
  ];
  for (const queryKey of options.invalidateQueryKeys ?? defaults) {
    void qc.invalidateQueries({ queryKey });
  }
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
