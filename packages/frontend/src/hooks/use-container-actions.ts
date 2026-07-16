import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { toast } from './use-toast.js';
import type { AgentTaskRefResponse, ContainerAction } from '@nyabase/common';
import { useAgentTaskTracker } from './use-agent-task-tracker.js';
import { containerActionPath } from '../lib/container-actions.js';
import { queryKeys } from '../lib/query-keys.js';

export interface ConfirmState {
  action: ContainerAction;
  containerId: string;
  name: string;
  title: string;
  description: string;
  confirmLabel: string;
  variant: 'default' | 'destructive';
}

export function useContainerActions(options: { admin?: boolean } = {}) {
  const qc = useQueryClient();
  const basePath = options.admin === true ? '/admin/v2/containers' : '/v2/containers';
  const [pendingActions, setPendingActions] = useState<Set<string>>(new Set());
  const [trackedTaskId, setTrackedTaskId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  useAgentTaskTracker(trackedTaskId, { admin: options.admin });

  const addPending = useCallback((key: string) => setPendingActions((s) => new Set([...s, key])), []);
  const removePending = useCallback((key: string) => setPendingActions((s) => {
    const next = new Set(s);
    next.delete(key);
    return next;
  }), []);

  const execAction = useCallback(async (action: ContainerAction, containerId: string) => {
    if (pendingActions.has(containerId)) return;
    addPending(containerId);
    try {
      const res = await api.post<AgentTaskRefResponse>(`${basePath}/${containerId}/actions/${containerActionPath(action)}`);
      setTrackedTaskId(res.taskId);
      const label: Partial<Record<ContainerAction, string>> = {
        start: '启动', stop: '停止', restart: '重启', delete: '删除',
        updateMounts: '更新挂载', reconcileSsh: '修复 SSH',
      };
      toast({
        title: `容器${label[action] ?? action}已排队`,
        description: `任务 ${res.taskId.slice(0, 8)}`,
      });
      void qc.invalidateQueries({
        queryKey: options.admin === true ? queryKeys.containers.adminList : queryKeys.containers.userList,
      });
      void qc.invalidateQueries({
        queryKey: queryKeys.containers.detail(options.admin === true ? 'admin' : 'user', containerId),
      });
    } catch (e) {
      toast({ title: '操作失败', description: (e as Error).message, variant: 'destructive' });
    } finally {
      removePending(containerId);
    }
  }, [pendingActions, qc, addPending, removePending, basePath, options.admin]);

  const doAction = useCallback((action: ContainerAction, containerId: string, name: string) => {
    if (pendingActions.has(containerId)) return;
    if (action === 'start') {
      void execAction(action, containerId);
      return;
    }
    const configs: Partial<Record<ContainerAction, Pick<ConfirmState, 'title' | 'description' | 'confirmLabel' | 'variant'>>> = {
      stop: { title: '停止容器', description: `确定要停止容器 "${name}"？正在运行的进程将被中断。`, confirmLabel: '停止', variant: 'default' },
      restart: { title: '重启容器', description: `确定要重启容器 "${name}"？容器将短暂中断后重新启动。`, confirmLabel: '重启', variant: 'default' },
      delete: { title: '删除容器', description: `确定要删除容器 "${name}"？此操作无法撤销。`, confirmLabel: '删除', variant: 'destructive' },
    };
    const cfg = configs[action];
    if (!cfg) {
      void execAction(action, containerId);
      return;
    }
    setConfirmState({ action, containerId, name, ...cfg });
  }, [pendingActions, execAction]);

  const handleConfirm = useCallback(async () => {
    if (!confirmState) return;
    const { action, containerId } = confirmState;
    setConfirmState(null);
    await execAction(action, containerId);
  }, [confirmState, execAction]);

  const handleCancel = useCallback(() => setConfirmState(null), []);

  return { doAction, pendingActions, confirmState, handleConfirm, handleCancel };
}
