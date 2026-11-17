import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FailureCode,
  type ContainerScriptDto,
  type PatchContainerScriptRequest,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { ApiError } from '../../lib/api-error.js';
import { toast } from '../../hooks/use-toast.js';
import { queryKeys } from '../../lib/query-keys.js';
import { containerScriptErrorMessage } from '../../lib/container-scripts.js';

export type ScriptCommand = 'pause' | 'resume' | 'archive';

const COMMAND_DONE: Record<ScriptCommand, string> = {
  pause: '容器脚本已暂停',
  resume: '容器脚本已恢复',
  archive: '容器脚本已归档',
};

const COMMAND_FAILED: Record<ScriptCommand, string> = {
  pause: '暂停失败',
  resume: '恢复失败',
  archive: '归档失败',
};

/** After any change: the answer is the script as it now is; lists and runs follow. */
function useScriptCache() {
  const queryClient = useQueryClient();
  return {
    settled: (updated: ContainerScriptDto) => {
      queryClient.setQueryData(queryKeys.containerScripts.detail(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.containerScripts.all });
    },
    failed: (scriptId: string, error: unknown) => {
      if (error instanceof ApiError && error.code === FailureCode.RevisionConflict) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.containerScripts.detail(scriptId) });
      }
    },
  };
}

/** 暂停 / 恢复 / 归档 (against the revision the page shows) and 重试. */
export function useScriptActions(scriptId: string) {
  const cache = useScriptCache();
  const command = useMutation({
    mutationFn: ({ action, expectedRevision }: { action: ScriptCommand; expectedRevision: number }) =>
      api.post<ContainerScriptDto>(`/admin/container-scripts/${scriptId}/${action}`, { expectedRevision }),
    onSuccess: (updated, { action }) => {
      toast({ title: COMMAND_DONE[action] });
      cache.settled(updated);
    },
    onError: (error, { action }) => {
      cache.failed(scriptId, error);
      toast({ title: COMMAND_FAILED[action], description: containerScriptErrorMessage(error), variant: 'destructive' });
    },
  });
  /** No ids: every failed container. */
  const retry = useMutation({
    mutationFn: (containerIds: string[] | undefined) =>
      api.post<ContainerScriptDto>(`/admin/container-scripts/${scriptId}/retry`, containerIds ? { containerIds } : {}),
    onSuccess: (updated, containerIds) => {
      toast({ title: containerIds ? '已安排重试' : '已安排重试全部失败的容器' });
      cache.settled(updated);
    },
    onError: (error) => {
      cache.failed(scriptId, error);
      toast({ title: '重试失败', description: containerScriptErrorMessage(error), variant: 'destructive' });
    },
  });
  const patch = useMutation({
    mutationFn: (body: PatchContainerScriptRequest) =>
      api.patch<ContainerScriptDto>(`/admin/container-scripts/${scriptId}`, body),
    onSuccess: (updated) => {
      toast({ title: '容器脚本已更新' });
      cache.settled(updated);
    },
    onError: (error) => cache.failed(scriptId, error),
  });
  return { command, retry, patch };
}
