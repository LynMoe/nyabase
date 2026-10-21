import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Gauge, HardDrive, Server, Trash2 } from 'lucide-react';
import {
  Capability,
  type SharedBackendDto,
  type SharedVolumeDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { MoreActions } from '../components/layout/more-actions.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { FsidConflictAlert } from '../components/storage/fsid-conflict-alert.js';
import { SharedVolumeCatalogInspectDialog } from '../components/storage/shared-volume-catalog-inspect.js';
import { volumeInProgress } from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { type SharedBackendFsidConflict } from '../lib/storage-shrink.js';
import { type SharedBackendDetailTab } from '../lib/shared-backend-detail.js';
import { useAuthStore } from '../store/auth.js';
import { DeleteBackendDialog, EditBackendDialog } from './shared-backend-detail-page/backend-dialogs.js';
import {
  BackendExecutorsTab,
  BackendOverviewTab,
  BackendVolumesTab,
} from './shared-backend-detail-page/backend-tabs.js';
import { useBackendEditForm } from './shared-backend-detail-page/use-backend-detail.js';
import { useBackendMutations } from './shared-backend-detail-page/use-backend-detail.js';

const routeApi = getRouteApi('/shared-backends/$id');

const TAB_ITEMS = [
  ['overview', '概览', Gauge],
  ['executors', '执行端', Server],
  ['volumes', '租户卷', HardDrive],
] as const;

export default function SharedBackendDetailPage() {
  const { id } = routeApi.useParams();
  const { tab } = routeApi.useSearch();
  const navigate = useNavigate({ from: '/shared-backends/$id' });
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const canManageSharedBackends = capabilities.includes(Capability.ManageSharedBackends);
  const canManageSharedVolumes = capabilities.includes(Capability.ManageSharedVolumes);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [inspectTarget, setInspectTarget] = useState<SharedVolumeDto | null>(null);
  const [pageConflict, setPageConflict] = useState<SharedBackendFsidConflict | null>(null);
  const [identityOpen, setIdentityOpen] = useState(false);

  const selectTab = (next: SharedBackendDetailTab) => {
    void navigate({ search: (prev) => ({ ...prev, tab: next }) });
  };

  const backendQuery = useQuery({
    queryKey: queryKeys.sharedBackends.detail(id),
    queryFn: () => api.get<SharedBackendDto>(`/shared-backends/${id}?scope=all`),
  });
  const volumesQuery = useQuery({
    queryKey: queryKeys.sharedVolumes.admin,
    queryFn: () => api.get<SharedVolumeDto[]>('/shared-volumes?scope=all'),
    enabled: tab === 'volumes' && canManageSharedVolumes,
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: 5_000,
      isSettled: (volumes) => volumes.every((volume) => !volumeInProgress(volume)),
    }),
  });

  const { patchBackend, patchExecutor, discoverExecutors, deleteBackend } = useBackendMutations({
    id,
    onConflict: setPageConflict,
    onIdentitySaved: () => setIdentityOpen(false),
    onDeleted: () => setDeleteOpen(false),
  });

  const backend = backendQuery.data;
  const edit = useBackendEditForm(backend, patchBackend);
  const title = backend?.displayName ?? backend?.name ?? '共享存储';

  return (
    <Page testId="shared-backend-detail">
      <PageHeader
        title={title}
        crumbs={[
          { label: '共享存储', to: '/shared-backends' },
          { label: title === '共享存储' ? '…' : title },
        ]}
        actions={
          backend && canManageSharedBackends ? (
            <MoreActions actions={[{ label: '删除后端', icon: Trash2, destructive: true, onSelect: () => setDeleteOpen(true) }]} />
          ) : undefined
        }
      />
      {pageConflict && (
        <FsidConflictAlert conflict={pageConflict} onDismiss={() => setPageConflict(null)} />
      )}
      <QueryView
        query={backendQuery}
        resourceName="共享后端"
        loadingLabel="加载共享后端..."
        onBack={() => window.history.back()}
      >
        {(loaded) => (
          <Tabs
            value={tab}
            onValueChange={(value) => selectTab(value as SharedBackendDetailTab)}
            data-testid="shared-backend-detail-tabs"
          >
            <TabsList>
              {TAB_ITEMS.map(([key, label, Icon]) => (
                <TabsTrigger key={key} value={key} className="gap-1.5" data-testid={`shared-backend-tab-${key}`}>
                  <Icon className="h-4 w-4" />{label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="overview" className="space-y-6">
              <BackendOverviewTab
                backend={loaded}
                canManage={canManageSharedBackends}
                onEdit={() => {
                  edit.reset(loaded);
                  setIdentityOpen(true);
                }}
              />
            </TabsContent>
            <TabsContent value="executors" className="space-y-6">
              <BackendExecutorsTab
                executors={loaded.executors ?? []}
                canManage={canManageSharedBackends}
                discoverExecutors={discoverExecutors}
                patchExecutor={patchExecutor}
              />
            </TabsContent>
            <TabsContent value="volumes">
              <BackendVolumesTab
                canManageVolumes={canManageSharedVolumes}
                loaded={volumesQuery.data !== undefined}
                failed={volumesQuery.isError}
                volumes={(volumesQuery.data ?? []).filter((volume) => volume.sharedBackendId === loaded.id)}
                onInspect={setInspectTarget}
              />
            </TabsContent>
          </Tabs>
        )}
      </QueryView>
      {identityOpen ? (
        <EditBackendDialog
          backend={backend}
          displayName={edit.displayName}
          overcommitRatio={edit.overcommitRatio}
          pending={patchBackend.isPending}
          onDisplayNameChange={edit.setDisplayName}
          onOvercommitChange={edit.setOvercommitRatio}
          onSave={edit.save}
          onClose={() => setIdentityOpen(false)}
        />
      ) : null}
      <SharedVolumeCatalogInspectDialog
        volume={inspectTarget}
        open={Boolean(inspectTarget)}
        onOpenChange={(open) => { if (!open) setInspectTarget(null); }}
      />
      <DeleteBackendDialog
        backend={backend}
        open={deleteOpen}
        pending={deleteBackend.isPending}
        onConfirm={() => deleteBackend.mutate()}
        onClose={() => setDeleteOpen(false)}
      />
    </Page>
  );
}
