import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SharedVolumeDto, UserServerDto, VolumeDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { LocalVolumeFormDialog } from '../components/storage/local-volume-form-dialog.js';
import { LocalVolumeTable } from '../components/storage/local-volume-table.js';
import { SharedVolumeTable } from '../components/storage/shared-volume-table.js';
import { volumeInProgress } from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { scopedPath } from '../lib/scoped-paths.js';
import { toast } from '../hooks/use-toast.js';

type DeleteTarget = { kind: 'local'; volume: VolumeDto } | { kind: 'shared'; volume: SharedVolumeDto };

const pollWhileInProgress = { steadyIntervalMs: 5_000, isSettled: (volumes: Array<VolumeDto | SharedVolumeDto>) => volumes.every((volume) => !volumeInProgress(volume)) };

/**
 * Every user's volumes, local and shared, under the administrator rules
 * (`scope=all`: no grant or quota checks). New volumes are created by their
 * owners on 数据卷 / 共享卷.
 */
export default function ManageVolumesPage() {
  const queryClient = useQueryClient();
  const [editTarget, setEditTarget] = useState<VolumeDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const localQuery = useQuery({
    queryKey: queryKeys.volumes.admin,
    queryFn: () => api.get<VolumeDto[]>('/volumes?scope=all'),
    refetchInterval: (query) => refetchWhileInProgress(query.state, pollWhileInProgress),
  });
  const sharedQuery = useQuery({
    queryKey: queryKeys.sharedVolumes.admin,
    queryFn: () => api.get<SharedVolumeDto[]>('/shared-volumes?scope=all'),
    refetchInterval: (query) => refetchWhileInProgress(query.state, pollWhileInProgress),
  });
  const serversQuery = useQuery({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get<UserServerDto[]>('/servers?scope=all'),
  });
  const serverNameById = new Map((serversQuery.data ?? []).map((server) => [server.id, server.name]));

  const deleteVolume = useMutation({
    mutationFn: (target: DeleteTarget) => api.delete<unknown>(scopedPath(
      target.kind === 'local' ? `/volumes/${target.volume.id}` : `/shared-volumes/${target.volume.id}`,
      'all',
    )),
    onSuccess: (_result, target) => {
      toast({ title: '删除已提交' });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({
        queryKey: target.kind === 'local' ? queryKeys.volumes.admin : queryKeys.sharedVolumes.all,
      });
    },
    onError: (error) => toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' }),
  });

  return (
    <Page testId="manage-volumes">
      <PageHeader
        title="全平台数据卷"
        description="所有用户的本地数据卷与共享卷。新建数据卷请到「数据卷」或「共享卷」页。"
      />
      <QueryView query={localQuery} resourceName="本地数据卷" loadingLabel="加载本地数据卷...">
        {(volumes) => (
          <SectionCard title="本地数据卷" flush>
            <LocalVolumeTable
              volumes={volumes}
              scope="all"
              showPoolColumn
              showServerColumn
              serverNameById={serverNameById}
              canManageContainersAny
              onEdit={setEditTarget}
              onDelete={(volume) => setDeleteTarget({ kind: 'local', volume })}
              testId="manage-local-volume-table"
            />
          </SectionCard>
        )}
      </QueryView>
      <QueryView query={sharedQuery} resourceName="共享卷" loadingLabel="加载共享卷...">
        {(volumes) => (
          <SectionCard title="共享卷" flush>
            <SharedVolumeTable
              volumes={volumes}
              scope="all"
              showBackendColumn
              onDelete={(volume) => setDeleteTarget({ kind: 'shared', volume })}
              testId="manage-shared-volume-table"
            />
          </SectionCard>
        )}
      </QueryView>
      <LocalVolumeFormDialog
        volume={editTarget ?? undefined}
        open={Boolean(editTarget)}
        onOpenChange={(open) => { if (!open) setEditTarget(null); }}
        scope="all"
        lockedServerId={editTarget?.serverId}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={deleteTarget?.kind === 'shared' ? '删除共享卷？' : '删除数据卷？'}
        description={
          <>
            <p>将删除「{deleteTarget?.volume.name}」。</p>
            <p className="mt-2">若该卷仍挂载在容器上，删除会被拒绝。请先卸载后再试。</p>
          </>
        }
        confirmLabel="确认删除"
        pendingLabel="提交中..."
        pending={deleteVolume.isPending}
        onConfirm={() => { if (deleteTarget) deleteVolume.mutate(deleteTarget); }}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      />
    </Page>
  );
}
