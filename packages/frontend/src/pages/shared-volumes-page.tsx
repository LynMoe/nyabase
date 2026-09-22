import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus, RefreshCw } from 'lucide-react';
import type { SharedVolumeDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Button } from '../components/ui/button.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { SharedVolumeFormDialog } from '../components/storage/shared-volume-form-dialog.js';
import { SharedVolumeTable } from '../components/storage/shared-volume-table.js';
import { volumeInProgress } from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { toast } from '../hooks/use-toast.js';

export default function SharedVolumesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SharedVolumeDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SharedVolumeDto | null>(null);
  const volumesQuery = useQuery({
    queryKey: queryKeys.sharedVolumes.user,
    queryFn: () => api.get<SharedVolumeDto[]>('/shared-volumes'),
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (volumes) => volumes.every((volume) => !volumeInProgress(volume)),
    }),
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
        actions={
          <>
            <Button variant="outline" size="icon" onClick={() => { void volumesQuery.refetch(); }} aria-label="刷新共享卷">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button variant="outline" asChild>
              <Link to="/quota">配额</Link>
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
            title="暂无共享卷。"
            action={<Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建共享卷</Button>}
          />
        }
      >
        {(volumes) => (
          <SectionCard flush>
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
