import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type ContainerAction,
  type ContainerDto,
  type IntentAcceptedDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { ContainerTable } from '../components/containers/container-table.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { runGatedMutation } from '../lib/resource-mutation-gate.js';
import { actionProgressHint, containerActionSubmittedTitle } from '../lib/status-labels.js';
import { toast } from '../hooks/use-toast.js';

export default function ManageContainersPage() {
  const queryClient = useQueryClient();
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.adminList,
    queryFn: () => api.get<ContainerDto[]>('/admin/containers'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 5_000 }),
  });
  const action = useMutation({
    mutationFn: ({ actionName, containerId }: { actionName: Extract<ContainerAction, 'start' | 'stop' | 'restart'>; containerId: string }) =>
      api.post<IntentAcceptedDto>(`/admin/containers/${containerId}/actions/${actionName}`),
    onSuccess: (_intent, variables) => {
      toast({
        title: containerActionSubmittedTitle(variables.actionName),
        description: actionProgressHint('list'),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.containers.adminList });
    },
    onError: (error) => toast({ title: '容器操作失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const onPowerAction = async (actionName: ContainerAction, container: ContainerDto) => {
    if (actionName === 'start' || actionName === 'stop' || actionName === 'restart') {
      const ran = await runGatedMutation(container.id, () =>
        action.mutateAsync({ actionName, containerId: container.id }).then(() => undefined),
      );
      if (!ran) return Promise.reject();
    }
  };

  return (
    <Page>
      <PageHeader
        title="容器管理"
        description="全部用户的容器。创建请到用户面「容器」。"
      />
      <QueryView
        query={containersQuery}
        resourceName="全局容器"
        loadingLabel="加载全局容器..."
        showEmpty={containersQuery.data?.length === 0}
        empty={<EmptyState title="暂无容器。" />}
      >
        {(containers) => (
          <SectionCard flush>
            <ContainerTable
              containers={containers}
              admin
              showServerColumn
              onAction={onPowerAction}
            />
          </SectionCard>
        )}
      </QueryView>
    </Page>
  );
}
