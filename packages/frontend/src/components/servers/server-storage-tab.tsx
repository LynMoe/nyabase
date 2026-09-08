import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Capability, type StoragePoolDto, type VolumeDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { ConfirmDialog } from '../layout/confirm-dialog.js';
import { SectionCard } from '../layout/section-card.js';
import { QueryErrorState, QueryLoadingState } from '../query-state.js';
import { LocalVolumeFormDialog } from '../storage/local-volume-form-dialog.js';
import { LocalVolumeTable } from '../storage/local-volume-table.js';
import { queryKeys } from '../../lib/query-keys.js';
import { queryPollInterval } from '../../lib/query-lifecycle.js';
import { toast } from '../../hooks/use-toast.js';
import { useAuthStore } from '../../store/auth.js';

export function ServerStorageTab({
  serverId,
  children,
}: {
  serverId: string;
  pools: StoragePoolDto[];
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const canManageVolumes = capabilities.includes(Capability.ManageVolumes);
  const canManageContainersAny = capabilities.includes(Capability.ManageContainersAny);
  const [formOpen, setFormOpen] = useState(false);
  const [formVolume, setFormVolume] = useState<VolumeDto | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<VolumeDto | null>(null);

  const volumesQuery = useQuery({
    queryKey: queryKeys.volumes.adminByServer(serverId),
    queryFn: () => api.get<VolumeDto[]>(`/admin/volumes?serverId=${serverId}`),
    enabled: canManageVolumes,
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 5_000 }),
  });

  const deleteVolume = useMutation({
    mutationFn: (volumeId: string) => api.delete<unknown>(`/admin/volumes/${volumeId}`),
    onSuccess: () => {
      toast({
        title: '删除已提交',
        description: '列表状态稍后更新；若出现「需要关注」，请查看行内说明。',
      });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.volumes.admin });
    },
    onError: (error) => toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const openEdit = (volume: VolumeDto) => {
    setFormVolume(volume);
    setFormOpen(true);
  };

  return (
    <div className="space-y-6">
      {children}
      {!canManageVolumes ? (
        <SectionCard title="本机数据卷">
          <p className="text-sm text-muted-foreground">
            查看本机数据卷需要「管理本地数据卷」权限
          </p>
        </SectionCard>
      ) : volumesQuery.data === undefined && volumesQuery.isError ? (
        <QueryErrorState
          error={volumesQuery.error}
          resourceName="本机数据卷"
          onRetry={() => { void volumesQuery.refetch(); }}
        />
      ) : volumesQuery.data === undefined ? (
        <QueryLoadingState label="加载本机数据卷..." />
      ) : (
        <SectionCard title="本机数据卷" flush>
          <LocalVolumeTable
            volumes={volumesQuery.data}
            plane="admin"
            showPoolColumn
            canManageContainersAny={canManageContainersAny}
            onEdit={openEdit}
            onDelete={setDeleteTarget}
            testId="server-volume-table"
          />
        </SectionCard>
      )}
      <LocalVolumeFormDialog
        volume={formVolume}
        open={formOpen && Boolean(formVolume)}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) {
            setFormVolume(undefined);
          }
        }}
        plane="admin"
        lockedServerId={serverId}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除数据卷？"
        description={
          <>
            <p>将删除「{deleteTarget?.name}」。</p>
            <p className="mt-2">若该卷仍挂载在容器上，删除会被拒绝。请先卸载后再试。</p>
          </>
        }
        confirmLabel="确认删除"
        pendingLabel="提交中..."
        pending={deleteVolume.isPending}
        onConfirm={() => { if (deleteTarget) deleteVolume.mutate(deleteTarget.id); }}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      />
    </div>
  );
}
