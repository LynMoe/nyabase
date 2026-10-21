import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { ContainerAction, ContainerDto, IntentAcceptedDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { useActionMutation } from '../hooks/use-action-mutation.js';
import { Button } from '../components/ui/button.js';
import { ContainerList } from '../components/containers/container-table.js';
import { CreateContainerDialog } from '../components/containers/create-container-dialog.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { runGatedMutation } from '../lib/resource-mutation-gate.js';
import { containerActionSubmittedTitle } from '../lib/status-labels.js';

export default function ContainersPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.userList,
    queryFn: () => api.get<ContainerDto[]>('/containers'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 5_000 }),
  });
  const action = useActionMutation({
    mutationFn: ({ actionName, containerId }: { actionName: Extract<ContainerAction, 'start' | 'stop' | 'restart'>; containerId: string }) =>
      api.post<IntentAcceptedDto>(`/containers/${containerId}/actions/${actionName}`),
    successTitle: ({ actionName }) => containerActionSubmittedTitle(actionName),
    errorTitle: '容器操作失败',
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: queryKeys.containers.userList }); },
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
            title="还没有容器"
            description="新建一个容器，几秒钟后就能通过 SSH 登录。"
            action={<Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建容器</Button>}
          />
        }
      >
        {(containers) => (
          <ContainerList containers={containers} onAction={onPowerAction} />
        )}
      </QueryView>
      <CreateContainerDialog open={createOpen} onOpenChange={setCreateOpen} />
    </Page>
  );
}

function isPowerAction(action: ContainerAction): action is Extract<ContainerAction, 'start' | 'stop' | 'restart'> {
  return action === 'start' || action === 'stop' || action === 'restart';
}
