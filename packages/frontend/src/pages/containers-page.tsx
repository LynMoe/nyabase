import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus, RefreshCw } from 'lucide-react';
import type { ContainerAction, ContainerDto, IntentAcceptedDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Button } from '../components/ui/button.js';
import { ContainerTable } from '../components/containers/container-table.js';
import { CreateContainerDialog } from '../components/containers/create-container-dialog.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { runGatedMutation } from '../lib/resource-mutation-gate.js';
import { containerActionSubmittedTitle } from '../lib/status-labels.js';
import { toast } from '../hooks/use-toast.js';

export default function ContainersPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.userList,
    queryFn: () => api.get<ContainerDto[]>('/containers'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 5_000 }),
  });
  const action = useMutation({
    mutationFn: ({ actionName, containerId }: { actionName: Extract<ContainerAction, 'start' | 'stop' | 'restart'>; containerId: string }) =>
      api.post<IntentAcceptedDto>(`/containers/${containerId}/actions/${actionName}`),
    onSuccess: (_intent, variables) => {
      toast({
        title: containerActionSubmittedTitle(variables.actionName),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.containers.userList });
    },
    onError: (error) => toast({ title: '容器操作失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const onPowerAction = async (actionName: ContainerAction, container: ContainerDto) => {
    if (!isPowerAction(actionName)) return;
    const ran = await runGatedMutation(container.id, () =>
      action.mutateAsync({ actionName, containerId: container.id }).then(() => undefined),
    );
    if (!ran) return Promise.reject();
  };

  return (
    <Page>
      <PageHeader
        title="容器"
        description={containersQuery.data ? `${containersQuery.data.length} 个容器` : undefined}
        actions={
          <>
            <Button variant="outline" size="icon" onClick={() => { void containersQuery.refetch(); }} aria-label="刷新容器">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button variant="outline" asChild>
              <Link to="/quota">配额</Link>
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />新建容器
            </Button>
          </>
        }
      />
      <QueryView
        query={containersQuery}
        resourceName="容器"
        loadingLabel="加载容器..."
        showEmpty={containersQuery.data?.length === 0}
        empty={
          <EmptyState
            title="暂无容器。"
            action={<Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建容器</Button>}
          />
        }
      >
        {(containers) => (
          <SectionCard flush>
            <ContainerTable
              containers={containers}
              showServerColumn
              onAction={onPowerAction}
            />
          </SectionCard>
        )}
      </QueryView>
      <CreateContainerDialog open={createOpen} onOpenChange={setCreateOpen} />
    </Page>
  );
}

function isPowerAction(action: ContainerAction): action is Extract<ContainerAction, 'start' | 'stop' | 'restart'> {
  return action === 'start' || action === 'stop' || action === 'restart';
}
