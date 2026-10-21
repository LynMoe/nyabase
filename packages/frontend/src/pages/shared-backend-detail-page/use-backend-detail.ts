import { useEffect, useState } from 'react';
import { useMutation, type UseMutationResult, useQueryClient } from '@tanstack/react-query';
import {
  FailureCode,
  type SharedBackendDto,
  type SharedBackendExecutorDiscoverResult,
  type SharedBackendExecutorDto,
  zPatchSharedBackendRequest,
} from '@nyabase/common';
import { useNavigate } from '@tanstack/react-router';
import { toast } from '../../hooks/use-toast.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { failureCodeLabel } from '../../lib/status-labels.js';
import {
  identityConflictFromDiscoverIssue,
  parseSharedBackendFsidConflict,
  type SharedBackendFsidConflict,
} from '../../lib/storage-shrink.js';

type PatchBackend = UseMutationResult<
  SharedBackendDto,
  Error,
  { expectedRevision: number; displayName?: string | null; overcommitRatio?: number }
>;

/** The identity edit form of a shared backend; its fields follow the loaded backend. */
export function useBackendEditForm(
  backend: SharedBackendDto | undefined,
  patchBackend: PatchBackend,
) {
  const [displayName, setDisplayName] = useState('');
  const [overcommitRatio, setOvercommitRatio] = useState('');

  const reset = (from: SharedBackendDto) => {
    setDisplayName(from.displayName ?? '');
    setOvercommitRatio(String(from.overcommitRatio));
  };

  useEffect(() => {
    if (backend) reset(backend);
  }, [backend]);

  const save = () => {
    if (!backend) return;
    const parsed = zPatchSharedBackendRequest.safeParse({
      expectedRevision: backend.revision,
      displayName: displayName.trim() || null,
      overcommitRatio: Number(overcommitRatio),
    });
    if (!parsed.success) {
      toast({
        title: '请检查参数',
        description: parsed.error.issues[0]?.message ?? '显示名称或超分比例无效',
        variant: 'destructive',
      });
      return;
    }
    patchBackend.mutate(parsed.data);
  };

  return { displayName, overcommitRatio, setDisplayName, setOvercommitRatio, reset, save };
}

/**
 * The mutations on one shared backend. An FSID identity conflict reported by
 * any of them is handed to `onConflict` so the page can show it.
 */
export function useBackendMutations({
  id,
  onConflict,
  onIdentitySaved,
  onDeleted,
}: {
  id: string;
  onConflict: (conflict: SharedBackendFsidConflict) => void;
  onIdentitySaved: () => void;
  onDeleted: () => void;
}) {
  const navigate = useNavigate({ from: '/shared-backends/$id' });
  const queryClient = useQueryClient();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.sharedBackends.detail(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.sharedBackends.admin });
  };
  const reportConflict = (error: unknown) => {
    const conflict = parseSharedBackendFsidConflict(error);
    if (conflict) onConflict(conflict);
  };

  const patchBackend = useMutation({
    mutationFn: (body: { expectedRevision: number; displayName?: string | null; overcommitRatio?: number }) =>
      api.patch<SharedBackendDto>(`/shared-backends/${id}`, body),
    onSuccess: () => {
      toast({ title: '共享后端已更新' });
      onIdentitySaved();
      invalidate();
    },
    onError: (error) => {
      reportConflict(error);
      toast({ title: '更新失败', description: errorMessage(error), variant: 'destructive' });
    },
  });
  const patchExecutor = useMutation({
    mutationFn: ({
      executor,
      registered,
    }: {
      executor: SharedBackendExecutorDto;
      registered: boolean;
    }) =>
      api.patch<SharedBackendExecutorDto>(
        `/shared-backends/${id}/executors/${executor.id}`,
        { expectedRevision: executor.revision, registered },
      ),
    onSuccess: (_data, variables) => {
      toast({ title: variables.registered ? '执行端已登记' : '已取消执行端登记' });
      invalidate();
    },
    onError: (error) => toast({ title: '执行端登记失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const discoverExecutors = useMutation({
    mutationFn: () =>
      api.post<SharedBackendExecutorDiscoverResult>(
        `/shared-backends/${id}/executors/discover`,
        {},
      ),
    onSuccess: (result) => {
      for (const issue of result.identityConflicts) {
        const conflict = identityConflictFromDiscoverIssue(issue);
        if (conflict) {
          onConflict(conflict);
          continue;
        }
        if (
          issue.code === FailureCode.StoragePoolInUse
          || issue.code === FailureCode.ServerUnreachable
        ) {
          toast({
            title: failureCodeLabel(issue.code) ?? issue.code,
            description: issue.message,
            variant: 'destructive',
          });
        }
      }
      if (result.identityConflicts.length === 0) {
        toast({ title: '执行端发现已完成', description: `发现 ${result.executors.length} 个执行端。` });
      }
      invalidate();
    },
    onError: (error) => {
      reportConflict(error);
      toast({ title: '发现执行端失败', description: errorMessage(error), variant: 'destructive' });
    },
  });
  const deleteBackend = useMutation({
    mutationFn: () => api.delete<void>(`/shared-backends/${id}`),
    onSuccess: () => {
      toast({ title: '共享后端已删除' });
      onDeleted();
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedBackends.admin });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedVolumes.admin });
      void navigate({ to: '/shared-backends' });
    },
    onError: (error) => {
      reportConflict(error);
      toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' });
    },
  });

  return { patchBackend, patchExecutor, discoverExecutors, deleteBackend };
}
