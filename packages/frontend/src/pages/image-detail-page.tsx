import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Gauge, RefreshCw, Server, Trash2 } from 'lucide-react';
import { type AdminImageDto, type ServerDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { Page } from '../components/layout/page-header.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { MoreActions } from '../components/layout/more-actions.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { assignmentInProgress, imageInProgress } from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { type ImageDetailTab } from '../lib/detail-tabs.js';
import { ImageAssignmentsTab, ImageOverviewTab } from './image-detail-page/image-tabs.js';
import { useImageMutations } from './image-detail-page/use-image-mutations.js';

const routeApi = getRouteApi('/images/$id');

const TAB_ITEMS = [
  ['overview', '概览', Gauge],
  ['assignments', '分配', Server],
] as const;

export default function ImageDetailPage() {
  const { id } = routeApi.useParams();
  const { tab } = routeApi.useSearch();
  const navigate = useNavigate({ from: '/images/$id' });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const mutations = useImageMutations({ id, onDeleted: () => setDeleteOpen(false) });

  const selectTab = (next: ImageDetailTab) => {
    void navigate({ search: (prev) => ({ ...prev, tab: next }) });
  };

  const imageQuery = useQuery({
    queryKey: queryKeys.images.detail(id),
    queryFn: () => api.get<AdminImageDto>(`/images/${id}?scope=all`),
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (image) => !imageInProgress(image)
        && image.assignments.every((assignment) => !assignmentInProgress(assignment)),
    }),
  });
  const serversQuery = useQuery({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get<ServerDto[]>('/servers?scope=all'),
    enabled: tab === 'assignments',
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
        actions={
          image && !image.deleting ? (
            <>
              <Button
                variant="outline"
                onClick={() => mutations.repullImage.mutate()}
                disabled={mutations.repullImage.isPending}
              >
                <RefreshCw className="h-4 w-4" />重新拉取
              </Button>
              <MoreActions actions={[{ label: '移除镜像', icon: Trash2, destructive: true, onSelect: () => setDeleteOpen(true) }]} />
            </>
          ) : undefined
        }
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
            onValueChange={(value) => selectTab(value as ImageDetailTab)}
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
            <TabsContent value="assignments" className="space-y-6">
              <ImageAssignmentsTab
                image={loaded}
                servers={serversQuery.data ?? []}
                mutations={mutations}
              />
            </TabsContent>
          </Tabs>
        )}
      </QueryView>
      <ConfirmDialog
        open={deleteOpen}
        title="移除镜像？"
        description="移除会先去掉各服务器上的指纹分配；仍被容器引用的镜像会由后端拒绝。"
        confirmLabel="确认移除"
        pendingLabel="提交中..."
        pending={mutations.deleteImage.isPending}
        onConfirm={() => mutations.deleteImage.mutate()}
        onOpenChange={setDeleteOpen}
      />
    </Page>
  );
}
