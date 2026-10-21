import { useQueryClient } from '@tanstack/react-query';
import type {
  AttachVolumeRequest,
  ContainerAction,
  IntentAcceptedDto,
  ListScope,
  PatchContainerLimitsRequest,
  PatchContainerRootSizeRequest,
  VolumeAttachmentDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { containerActionSubmittedTitle } from '../../lib/status-labels.js';
import { useActionMutation } from '../../hooks/use-action-mutation.js';

/** Every mutation the container detail page can submit; each refreshes the page data on success. */
export function useContainerDetailActions({
  containerId,
  scope,
  base,
  detachTarget,
  onDetached,
}: {
  containerId: string;
  scope: ListScope;
  base: string;
  detachTarget: VolumeAttachmentDto | null;
  onDetached: () => void;
}) {
  const queryClient = useQueryClient();
  const admin = scope === 'all';

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers.detail(scope, containerId) });
    void queryClient.invalidateQueries({ queryKey: admin ? queryKeys.containers.adminList : queryKeys.containers.userList });
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers.attachments(scope, containerId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers.intents(scope, containerId) });
  };

  const action = useActionMutation({
    mutationFn: (name: Extract<ContainerAction, 'start' | 'stop' | 'restart' | 'delete'>) =>
      api.post<IntentAcceptedDto>(`${base}/actions/${name}`),
    successTitle: (name) => containerActionSubmittedTitle(name),
    errorTitle: '容器操作失败',
    onSuccess: invalidate,
  });
  const updateLimits = useActionMutation({
    mutationFn: (body: PatchContainerLimitsRequest) => api.patch<IntentAcceptedDto>(`${base}/limits`, body),
    successTitle: '已提交规格更新，正在生效',
    errorTitle: '规格更新失败',
    onSuccess: invalidate,
  });
  const resizeRoot = useActionMutation({
    mutationFn: (body: PatchContainerRootSizeRequest) => api.patch<IntentAcceptedDto>(`${base}/root-size`, body),
    successTitle: '已提交系统盘调整，正在生效',
    errorTitle: '系统盘调整失败',
    onSuccess: invalidate,
  });
  const updateGpus = useActionMutation({
    mutationFn: (pciAddresses: string[]) =>
      api.patch<IntentAcceptedDto>(`${base}/gpus`, { pciAddresses }),
    successTitle: '已提交 GPU 更新，正在生效',
    errorTitle: 'GPU 更新失败',
    onSuccess: invalidate,
  });
  const attachLocal = useActionMutation({
    mutationFn: (body: AttachVolumeRequest) => api.post<IntentAcceptedDto>(`${base}/volumes`, body),
    successTitle: '已提交挂载，正在生效',
    errorTitle: '挂载失败',
    onSuccess: invalidate,
  });
  const attachShared = useActionMutation({
    mutationFn: (body: AttachVolumeRequest) => api.post<IntentAcceptedDto>(`${base}/shared-volumes`, body),
    successTitle: '已提交挂载，正在生效',
    errorTitle: '挂载失败',
    onSuccess: invalidate,
  });
  const detach = useActionMutation({
    mutationFn: (attachmentId: string) => {
      const path = detachTarget?.kind === 'shared' ? 'shared-volumes' : 'volumes';
      return api.delete<IntentAcceptedDto>(`${base}/${path}/${attachmentId}`);
    },
    successTitle: '已提交卸载，正在生效',
    errorTitle: '卸载失败',
    onSuccess: () => {
      onDetached();
      invalidate();
    },
  });
  const repairSsh = useActionMutation({
    mutationFn: () => api.post<{ woken: boolean }>(`${base}/actions/repair-ssh`),
    successTitle: '已提交 SSH 修复',
    errorTitle: 'SSH 修复失败',
    onSuccess: invalidate,
  });

  return {
    invalidate,
    action,
    updateLimits,
    resizeRoot,
    updateGpus,
    attachLocal,
    attachShared,
    detach,
    repairSsh,
  };
}

export type ContainerDetailActions = ReturnType<typeof useContainerDetailActions>;
