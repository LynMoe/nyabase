import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SharedVolumeDto, UserServerDto, VolumeDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { DeleteVolumeDialog, type DeleteVolumeTarget } from '../components/storage/delete-volume-dialog.js';
import { LocalVolumeTable } from '../components/storage/local-volume-table.js';
import { SharedVolumeTable } from '../components/storage/shared-volume-table.js';
import { volumeInProgress } from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { VolumeDetailFocus } from '../components/storage/volume-detail-focus.js';

function useVolumeFocus(): VolumeDetailFocus {
  const search = useSearch({ from: '/manage/volumes/' });
  const navigate = useNavigate({ from: '/manage/volumes/' });
  return {
    id: search.volume ?? null,
    onChange: (id) => { void navigate({ search: (prev) => ({ ...prev, volume: id ?? undefined }), replace: true }); },
  };
}

const pollWhileInProgress = { steadyIntervalMs: 5_000, isSettled: (volumes: Array<VolumeDto | SharedVolumeDto>) => volumes.every((volume) => !volumeInProgress(volume)) };

/**
 * Every user's volumes, local and shared (`scope=all`). The platform creates,
 * sizes and mounts them from the grants; administrators only look, and delete
 * a volume no grant covers any more.
 */
export default function ManageVolumesPage() {
  const detailFocus = useVolumeFocus();
  const [deleteTarget, setDeleteTarget] = useState<DeleteVolumeTarget | null>(null);
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

  return (
    <Page testId="manage-volumes">
      <PageHeader
        title="全平台数据卷"
        description="数据卷由平台按授权自动创建、调整容量并挂载到用户的所有容器；只有不再被任何授权覆盖的卷可以删除。"
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
              onDelete={(volume) => setDeleteTarget({ kind: 'local', volume })}
              testId="manage-local-volume-table"
              detailFocus={detailFocus}
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
              detailFocus={detailFocus}
            />
          </SectionCard>
        )}
      </QueryView>
      <DeleteVolumeDialog target={deleteTarget} onClose={() => setDeleteTarget(null)} />
    </Page>
  );
}
