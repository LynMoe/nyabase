import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { ContainerAction, ContainerDto, IntentAcceptedDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { useActionMutation } from '../hooks/use-action-mutation.js';
import { ContainerList, type ContainerListGrouping } from '../components/containers/container-table.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { scopedPath } from '../lib/scoped-paths.js';
import { runGatedMutation } from '../lib/resource-mutation-gate.js';
import { containerActionSubmittedTitle } from '../lib/status-labels.js';
import {
  collapsedKeys,
  DEFAULT_CONTAINER_GROUPING,
  serializeCollapsed,
} from '../lib/container-groups.js';

export default function ManageContainersPage() {
  const queryClient = useQueryClient();
  const grouping = useUrlGrouping();
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.adminList,
    queryFn: () => api.get<ContainerDto[]>('/containers?scope=all'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 5_000 }),
  });
  const action = useActionMutation({
    mutationFn: ({ actionName, containerId }: { actionName: Extract<ContainerAction, 'start' | 'stop' | 'restart'>; containerId: string }) =>
      api.post<IntentAcceptedDto>(scopedPath(`/containers/${containerId}/actions/${actionName}`, 'all')),
    successTitle: ({ actionName }) => containerActionSubmittedTitle(actionName),
    errorTitle: '容器操作失败',
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: queryKeys.containers.adminList }); },
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
        title="全平台容器"
        description={containersQuery.data ? `${containersQuery.data.length} 个容器` : undefined}
      />
      <QueryView
        query={containersQuery}
        resourceName="全局容器"
        loadingLabel="加载全局容器..."
        showEmpty={containersQuery.data?.length === 0}
        empty={<EmptyState title="暂无容器。" />}
      >
        {(containers) => (
          <ContainerList containers={containers} admin grouping={grouping} onAction={onPowerAction} />
        )}
      </QueryView>
    </Page>
  );
}

/** `?group=` and `?collapsed=` hold the folding, so a reload or a shared link opens the same view. */
function useUrlGrouping(): ContainerListGrouping {
  const search = useSearch({ from: '/manage/containers/' });
  const navigate = useNavigate({ from: '/manage/containers/' });
  return {
    value: search.group ?? DEFAULT_CONTAINER_GROUPING,
    collapsed: collapsedKeys(search),
    onChange: (value) => {
      // Folded keys belong to one grouping; switching starts with every group open.
      void navigate({ search: { group: value === DEFAULT_CONTAINER_GROUPING ? undefined : value }, replace: true });
    },
    onCollapsedChange: (keys) => {
      void navigate({ search: (prev) => ({ ...prev, collapsed: serializeCollapsed(keys) }), replace: true });
    },
  };
}
