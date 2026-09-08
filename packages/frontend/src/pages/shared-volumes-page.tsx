import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import type { EffectiveAccessDto, SharedBackendDto, SharedVolumeDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Button } from '../components/ui/button.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { MetaChip, SectionCard } from '../components/layout/section-card.js';
import { SharedVolumeFormDialog } from '../components/storage/shared-volume-form-dialog.js';
import { SharedVolumeTable } from '../components/storage/shared-volume-table.js';
import { formatGrantBytes, formatRemainingBytes } from '../lib/grant-quota.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from '../hooks/use-toast.js';

export default function SharedVolumesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SharedVolumeDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SharedVolumeDto | null>(null);
  const volumesQuery = useQuery({
    queryKey: queryKeys.sharedVolumes.user,
    queryFn: () => api.get<SharedVolumeDto[]>('/shared-volumes'),
  });
  const accessQuery = useQuery({
    queryKey: queryKeys.meAccess,
    queryFn: () => api.get<EffectiveAccessDto>('/me/access'),
  });
  const backendsQuery = useQuery({
    queryKey: queryKeys.sharedBackends.user,
    queryFn: () => api.get<SharedBackendDto[]>('/shared-backends'),
    enabled: (accessQuery.data?.sharedBackends.length ?? 0) > 0,
  });
  const deleteVolume = useMutation({
    mutationFn: (volumeId: string) => api.delete<unknown>(`/shared-volumes/${volumeId}`),
    onSuccess: () => {
      toast({
        title: '删除已提交',
        description: '从未挂载的预订会立即删除；已有目录的删除稍后完成。',
      });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedVolumes.all });
    },
    onError: (error) => toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' }),
  });
  return (
    <Page testId="shared-volumes">
      <PageHeader
        title="共享卷"
        description="绑定共享存储后端的配额预订。创建时不会立刻在机器上建目录。"
        actions={
          <>
            <Button variant="outline" size="icon" onClick={() => { void volumesQuery.refetch(); }} aria-label="刷新共享卷">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建共享卷</Button>
          </>
        }
      />
      <QueryView
        query={volumesQuery}
        resourceName="共享卷"
        loadingLabel="加载共享卷..."
        showEmpty={volumesQuery.data?.length === 0}
        empty={
          <EmptyState
            title="暂无共享卷。创建后即可挂载到能看见该后端的容器。"
            action={<Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建共享卷</Button>}
          />
        }
      >
        {(volumes) => (
          <SectionCard
            flush
            toolbar={(accessQuery.data?.sharedBackends.length ?? 0) > 0 ? (
              <SharedBackendRemainingRow
                access={accessQuery.data?.sharedBackends ?? []}
                backends={backendsQuery.data ?? []}
              />
            ) : undefined}
          >
            <SharedVolumeTable
              volumes={volumes}
              plane="user"
              showBackendColumn
              onEdit={setEditTarget}
              onDelete={setDeleteTarget}
            />
          </SectionCard>
        )}
      </QueryView>
      <SharedVolumeFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editTarget && (
        <SharedVolumeFormDialog
          sharedVolume={editTarget}
          open
          onOpenChange={(open) => { if (!open) setEditTarget(null); }}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除共享卷？"
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

function SharedBackendRemainingRow({
  access,
  backends,
}: {
  access: EffectiveAccessDto['sharedBackends'];
  backends: SharedBackendDto[];
}) {
  if (access.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {access.map((item) => {
        const backend = backends.find((row) => row.id === item.sharedBackendId);
        const name = backend?.displayName ?? backend?.name ?? item.sharedBackendId;
        const unlimited = item.limitBytes === null || item.limitBytes === 0;
        return (
          <MetaChip key={item.sharedBackendId}>
            {name}
            {unlimited
              ? ' · 额度不限'
              : ` · 剩余 ${formatRemainingBytes(item.limitBytes, item.usedBytes)} / 额度 ${formatGrantBytes(item.limitBytes)}`}
          </MetaChip>
        );
      })}
    </div>
  );
}
