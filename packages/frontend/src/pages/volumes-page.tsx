import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import type { StorageCapacityDto, UserServerDto, VolumeDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Button } from '../components/ui/button.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { MetaChip, SectionCard } from '../components/layout/section-card.js';
import { LocalVolumeFormDialog } from '../components/storage/local-volume-form-dialog.js';
import { LocalVolumeTable } from '../components/storage/local-volume-table.js';
import { grantAvailableLabel } from '../lib/utils.js';
import { formatGrantBytes } from '../lib/grant-quota.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from '../hooks/use-toast.js';

export default function VolumesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [lockedServerId, setLockedServerId] = useState<string | undefined>(undefined);
  const [editTarget, setEditTarget] = useState<VolumeDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VolumeDto | null>(null);
  const volumesQuery = useQuery({
    queryKey: queryKeys.volumes.user,
    queryFn: () => api.get<VolumeDto[]>('/volumes'),
  });
  const serversQuery = useQuery({
    queryKey: queryKeys.servers.user,
    queryFn: () => api.get<UserServerDto[]>('/servers'),
  });
  const deleteVolume = useMutation({
    mutationFn: (volumeId: string) => api.delete<unknown>(`/volumes/${volumeId}`),
    onSuccess: () => {
      toast({
        title: '删除已提交',
        description: '列表状态稍后更新；若出现「需要关注」，请查看行内说明。',
      });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.volumes.user });
    },
    onError: (error) => toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const openCreate = (serverId?: string) => {
    setLockedServerId(serverId);
    setCreateOpen(true);
  };

  return (
    <Page testId="volumes">
      <PageHeader
        title="数据卷"
        description="服务器本地盘。共享卷请到「共享卷」。扩缩容是否需先卸载，取决于所选存储池的能力。"
        actions={
          <>
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                void volumesQuery.refetch();
                void serversQuery.refetch();
              }}
              aria-label="刷新数据卷"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button onClick={() => openCreate()}><Plus className="h-4 w-4" />新建数据卷</Button>
          </>
        }
      />
      <QueryView
        queries={[volumesQuery, serversQuery]}
        resourceNames={['数据卷', '服务器']}
        loadingLabel="加载数据卷..."
      >
        {() => (
          <VolumeList
            volumes={volumesQuery.data ?? []}
            servers={serversQuery.data ?? []}
            onCreate={openCreate}
            onEdit={setEditTarget}
            onDelete={setDeleteTarget}
          />
        )}
      </QueryView>
      <LocalVolumeFormDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setLockedServerId(undefined);
        }}
        lockedServerId={lockedServerId}
      />
      {editTarget && (
        <LocalVolumeFormDialog
          volume={editTarget}
          open
          onOpenChange={(open) => { if (!open) setEditTarget(null); }}
        />
      )}
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
    </Page>
  );
}

function VolumeList({
  volumes,
  servers,
  onCreate,
  onEdit,
  onDelete,
}: {
  volumes: VolumeDto[];
  servers: UserServerDto[];
  onCreate: (serverId?: string) => void;
  onEdit: (volume: VolumeDto) => void;
  onDelete: (volume: VolumeDto) => void;
}) {
  const serverNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const server of servers) map.set(server.id, server.name);
    return map;
  }, [servers]);

  if (servers.length === 0 && volumes.length === 0) {
    return (
      <EmptyState
        title="暂无本地数据卷。创建后即可挂载到容器。"
        action={<Button onClick={() => onCreate()}><Plus className="h-4 w-4" />新建数据卷</Button>}
      />
    );
  }

  const chips = servers.filter((server) => server.status === 'online');
  return (
    <SectionCard
      flush
      toolbar={chips.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {chips.map((server) => (
            <ServerDiskRemainingChip key={server.id} server={server} />
          ))}
        </div>
      ) : undefined}
    >
      <LocalVolumeTable
        volumes={volumes}
        plane="user"
        showPoolColumn
        showServerColumn
        serverNameById={serverNameById}
        onEdit={onEdit}
        onDelete={onDelete}
        testId="volume-server-table"
      />
    </SectionCard>
  );
}

function ServerDiskRemainingChip({ server }: { server: UserServerDto }) {
  const capacityQuery = useQuery({
    queryKey: queryKeys.storageCapacity(server.id),
    queryFn: () => api.get<StorageCapacityDto>(`/servers/${server.id}/storage-capacity`),
  });
  if (!capacityQuery.data) return null;
  const capacity = capacityQuery.data;
  const unlimited = capacity.grantLimitBytes === null || capacity.grantLimitBytes === 0;
  return (
    <MetaChip>
      {server.name}
      {unlimited
        ? ' · 额度不限'
        : ` · 剩余 ${grantAvailableLabel(capacity.availableBytes, capacity.grantLimitBytes)} / 额度 ${formatGrantBytes(capacity.grantLimitBytes)}`}
    </MetaChip>
  );
}
