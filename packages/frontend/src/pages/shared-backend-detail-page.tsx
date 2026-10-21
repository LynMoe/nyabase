import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Gauge, HardDrive, Server } from 'lucide-react';
import { Capability, type SharedBackendDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { FsidConflictAlert } from '../components/storage/fsid-conflict-alert.js';
import { queryKeys } from '../lib/query-keys.js';
import { type SharedBackendFsidConflict } from '../lib/storage-shrink.js';
import { type SharedBackendDetailTab } from '../lib/detail-tabs.js';
import { useAuthStore } from '../store/auth.js';
import { DeleteBackendAction } from './shared-backend-detail-page/backend-dialogs.js';
import {
  BackendExecutorsTab,
  BackendOverviewTab,
  BackendVolumesTab,
} from './shared-backend-detail-page/backend-tabs.js';

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
  const canManageSharedBackends = useAuthStore(
    (state) => state.user?.capabilities.includes(Capability.ManageSharedBackends) ?? false,
  );
  const [conflict, setConflict] = useState<SharedBackendFsidConflict | null>(null);
  const backendQuery = useQuery({
    queryKey: queryKeys.sharedBackends.detail(id),
    queryFn: () => api.get<SharedBackendDto>(`/shared-backends/${id}?scope=all`),
  });
  const backend = backendQuery.data;
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
            <DeleteBackendAction backend={backend} onConflict={setConflict} />
          ) : undefined
        }
      />
      {conflict && <FsidConflictAlert conflict={conflict} onDismiss={() => setConflict(null)} />}
      <QueryView
        query={backendQuery}
        resourceName="共享后端"
        loadingLabel="加载共享后端..."
        onBack={() => window.history.back()}
      >
        {(loaded) => (
          <Tabs
            value={tab}
            onValueChange={(value) => {
              void navigate({ search: (prev) => ({ ...prev, tab: value as SharedBackendDetailTab }) });
            }}
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
              <BackendOverviewTab backend={loaded} onConflict={setConflict} />
            </TabsContent>
            <TabsContent value="executors" className="space-y-6">
              <BackendExecutorsTab backend={loaded} onConflict={setConflict} />
            </TabsContent>
            <TabsContent value="volumes">
              <BackendVolumesTab backendId={loaded.id} />
            </TabsContent>
          </Tabs>
        )}
      </QueryView>
    </Page>
  );
}
