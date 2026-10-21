import { useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Gauge, Terminal, TriangleAlert } from 'lucide-react';
import type { ContainerAction, ListScope, VolumeAttachmentDto } from '@nyabase/common';
import { Alert, AlertDescription } from '../components/ui/alert.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { Page } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { ContainerConsole } from '../components/containers/container-console.js';
import { RootShrinkOrchestrationDialog } from '../components/storage/root-shrink-orchestration-dialog.js';
import { runGatedMutation } from '../lib/resource-mutation-gate.js';
import { useResourceMutationPending } from '../lib/resource-mutation-gate.js';
import { ContainerDetailHeader } from './container-detail-page/detail-sections.js';
import { DetachVolumeDialog, IntentHistoryDialog } from './container-detail-page/detail-dialogs.js';
import { ContainerOverviewTab } from './container-detail-page/detail-sections.js';
import { parseDetailTab, type DetailTab } from './container-detail-page/use-container-detail.js';
import { useContainerDetailActions } from './container-detail-page/use-container-detail.js';
import { useContainerDetailData } from './container-detail-page/use-container-detail.js';

export { parseDetailTab, type DetailTab };

const userRouteApi = getRouteApi('/containers/$containerId');
const adminRouteApi = getRouteApi('/manage/containers/$containerId');

const DETAIL_TAB_ITEMS = [
  ['overview', '概况', Gauge],
  ['console', '控制台', Terminal],
] as const;

export default function ContainerDetailPage() {
  const { containerId } = userRouteApi.useParams();
  const { tab } = userRouteApi.useSearch();
  return <ContainerDetailContent containerId={containerId} scope="mine" tab={tab} />;
}

export function AdminContainerDetailPage() {
  const { containerId } = adminRouteApi.useParams();
  const { tab } = adminRouteApi.useSearch();
  return <ContainerDetailContent containerId={containerId} scope="all" tab={tab} />;
}

function ContainerDetailContent({
  containerId,
  scope,
  tab,
}: {
  containerId: string;
  scope: ListScope;
  tab: DetailTab;
}) {
  const admin = scope === 'all';
  const navigate = useNavigate({ from: admin ? '/manage/containers/$containerId' : '/containers/$containerId' });
  const [rootOrchestrateSize, setRootOrchestrateSize] = useState<number | null>(null);
  const [detachTarget, setDetachTarget] = useState<VolumeAttachmentDto | null>(null);
  const [intentsOpen, setIntentsOpen] = useState(false);
  const actionPending = useResourceMutationPending(containerId);
  const data = useContainerDetailData({ containerId, scope, tab, intentsOpen });
  const actions = useContainerDetailActions({
    containerId,
    scope,
    base: data.base,
    detachTarget,
    onDetached: () => setDetachTarget(null),
  });

  const selectTab = (next: DetailTab) => {
    void navigate({ search: (prev) => ({ ...prev, tab: next }), replace: true });
  };
  const runAction = async (name: Extract<ContainerAction, 'start' | 'stop' | 'restart' | 'delete'>) => {
    const ran = await runGatedMutation(containerId, () =>
      actions.action.mutateAsync(name).then(() => undefined),
    );
    if (!ran) return Promise.reject();
  };

  return (
    <Page testId="container-canonical-detail">
      <ContainerDetailHeader
        container={data.containerQuery.data}
        admin={admin}
        actionPending={actionPending}
        onShowHistory={() => setIntentsOpen(true)}
        onAction={runAction}
      />
      <QueryView
        query={data.containerQuery}
        resourceName="容器"
        loadingLabel="加载容器..."
        onBack={() => window.history.back()}
      >
        {(container) => (
          <>
            {container.needsAttention && (
              <Alert variant="destructive">
                <TriangleAlert className="h-4 w-4" />
                <AlertDescription>
                  {container.failureReason ?? container.failureCode ?? '容器需要人工关注。'}
                </AlertDescription>
              </Alert>
            )}

            <Tabs value={tab} onValueChange={(value) => selectTab(value as DetailTab)}>
              <TabsList className="h-auto w-full flex-nowrap justify-start overflow-x-auto">
                {DETAIL_TAB_ITEMS.map(([key, label, Icon]) => (
                  <TabsTrigger key={key} value={key} className="gap-1.5">
                    <Icon className="h-4 w-4" />{label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="overview" className="space-y-3">
                <ContainerOverviewTab
                  container={container}
                  scope={scope}
                  data={data}
                  actions={actions}
                  onDetachRequest={setDetachTarget}
                  onRootRequiresStop={setRootOrchestrateSize}
                />
              </TabsContent>
              <TabsContent value="console">
                <ContainerConsole container={container} />
              </TabsContent>
            </Tabs>

            {rootOrchestrateSize !== null && (
              <RootShrinkOrchestrationDialog
                scope={scope}
                container={container}
                sizeBytes={rootOrchestrateSize}
                open
                onOpenChange={(open) => { if (!open) setRootOrchestrateSize(null); }}
                onComplete={actions.invalidate}
              />
            )}
            <IntentHistoryDialog
              open={intentsOpen}
              onOpenChange={setIntentsOpen}
              query={data.intentsQuery}
              scope={scope}
            />
            <DetachVolumeDialog
              container={container}
              target={detachTarget}
              pending={actions.detach.isPending}
              onConfirm={(attachmentId) => {
                void actions.detach.mutateAsync(attachmentId).then(() => undefined, () => undefined);
              }}
              onClose={() => setDetachTarget(null)}
            />
          </>
        )}
      </QueryView>
    </Page>
  );
}
