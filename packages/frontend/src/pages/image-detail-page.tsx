import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Gauge, History, Server } from 'lucide-react';
import type { AdminImageDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { assignmentInProgress, imageInProgress } from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { type ImageDetailTab } from '../lib/detail-tabs.js';
import { ImageAssignmentsTab, ImageHeaderActions, ImageOverviewTab } from './image-detail-page/image-tabs.js';
import { ImageVersionsTab } from './image-detail-page/image-versions-tab.js';

const routeApi = getRouteApi('/images/$id');

const TAB_ITEMS = [
  ['overview', '概览', Gauge],
  ['versions', '版本', History],
  ['assignments', '分配', Server],
] as const;

export default function ImageDetailPage() {
  const { id } = routeApi.useParams();
  const { tab } = routeApi.useSearch();
  const navigate = useNavigate({ from: '/images/$id' });
  const imageQuery = useQuery({
    queryKey: queryKeys.images.detail(id),
    queryFn: () => api.get<AdminImageDto>(`/images/${id}?scope=all`),
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (image) => !imageInProgress(image)
        && image.assignments.every((assignment) => !assignmentInProgress(assignment)),
    }),
  });
  const image = imageQuery.data;

  return (
    <Page testId="image-detail">
      <PageHeader
        title={image?.alias ?? '镜像'}
        crumbs={[
          { label: '镜像', to: '/images' },
          { label: image?.alias ?? '…' },
        ]}
        actions={image && !image.deleting ? <ImageHeaderActions image={image} /> : undefined}
      />
      <QueryView
        query={imageQuery}
        resourceName="镜像"
        loadingLabel="加载镜像..."
        onBack={() => window.history.back()}
      >
        {(loaded) => (
          <Tabs
            value={tab}
            onValueChange={(value) => {
              void navigate({ search: (prev) => ({ ...prev, tab: value as ImageDetailTab }) });
            }}
            data-testid="image-detail-tabs"
          >
            <TabsList>
              {TAB_ITEMS.map(([key, label, Icon]) => (
                <TabsTrigger key={key} value={key} className="gap-1.5">
                  <Icon className="h-4 w-4" />{label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="overview" className="space-y-6">
              <ImageOverviewTab image={loaded} />
            </TabsContent>
            <TabsContent value="versions" className="space-y-6">
              <ImageVersionsTab image={loaded} />
            </TabsContent>
            <TabsContent value="assignments" className="space-y-6">
              <ImageAssignmentsTab image={loaded} />
            </TabsContent>
          </Tabs>
        )}
      </QueryView>
    </Page>
  );
}
