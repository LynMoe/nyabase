import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Plus, RefreshCw, Server } from 'lucide-react';
import type { ContainerAction, ContainerDto, IntentAcceptedDto, UserServerDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';
import { ContainerRow } from '../components/containers/container-row.js';
import { CreateContainerDialog } from '../components/containers/create-container-dialog.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { runGatedMutation } from '../lib/resource-mutation-gate.js';
import { actionProgressHint, containerActionSubmittedTitle, serverStatusLabel } from '../lib/status-labels.js';
import { toast } from '../hooks/use-toast.js';

export default function ContainersPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [defaultServerId, setDefaultServerId] = useState<string | undefined>();
  const serversQuery = useQuery({ queryKey: queryKeys.servers.user, queryFn: () => api.get<UserServerDto[]>('/servers') });
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
        description: actionProgressHint('list'),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.containers.userList });
    },
    onError: (error) => toast({ title: '容器操作失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const containers = containersQuery.data ?? [];
  const grouped = useMemo(() => {
    const map = new Map<string, ContainerDto[]>();
    for (const container of containers) map.set(container.serverId, [...(map.get(container.serverId) ?? []), container]);
    return map;
  }, [containers]);

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
        description={
          containersQuery.data
            ? `${containersQuery.data.length} 个容器 · 运行时状态来自后端观测`
            : '运行时状态来自后端观测'
        }
        actions={
          <>
            <Button variant="outline" size="icon" onClick={() => { void Promise.all([serversQuery.refetch(), containersQuery.refetch()]); }} aria-label="刷新容器">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button onClick={() => { setDefaultServerId(undefined); setCreateOpen(true); }}>
              <Plus className="h-4 w-4" />新建容器
            </Button>
          </>
        }
      />
      <QueryView
        queries={[serversQuery, containersQuery]}
        resourceNames={['服务器', '容器']}
        loadingLabel="加载容器..."
      >
        {() => {
          const servers = serversQuery.data ?? [];
          if (servers.length === 0 && containers.length === 0) {
            return <EmptyState title="暂无可访问的服务器或容器。" />;
          }
          return (
            <div className="space-y-5">
              {servers.map((server) => (
                <ServerContainerGroup
                  key={server.id}
                  server={server}
                  containers={grouped.get(server.id) ?? []}
                  onCreate={() => { setDefaultServerId(server.id); setCreateOpen(true); }}
                  onAction={onPowerAction}
                />
              ))}
              {containers
                .filter((container) => !servers.some((server) => server.id === container.serverId))
                .map((container) => (
                  <Card key={container.id}>
                    <ContainerRow
                      container={container}
                      onAction={onPowerAction}
                    />
                  </Card>
                ))}
            </div>
          );
        }}
      </QueryView>
      <CreateContainerDialog open={createOpen} onOpenChange={setCreateOpen} defaultServerId={defaultServerId} />
    </Page>
  );
}

function ServerContainerGroup({
  server,
  containers,
  onCreate,
  onAction,
}: {
  server: UserServerDto;
  containers: ContainerDto[];
  onCreate: () => void;
  onAction: (action: ContainerAction, container: ContainerDto) => void | Promise<void>;
}) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{server.name}</span>
          <Badge variant={server.status === 'online' ? 'success' : 'secondary'} title={server.status}>
            {serverStatusLabel(server.status)}
          </Badge>
          <span className="text-xs text-muted-foreground">{containers.length} 个</span>
        </div>
        <Button size="sm" variant="outline" onClick={onCreate} aria-label={`在 ${server.name} 新建容器`}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <Card>
        <CardContent className="divide-y p-0">
          {containers.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">该服务器暂无容器。</p>
          ) : (
            containers.map((container) => (
              <ContainerRow key={container.id} container={container} onAction={onAction} />
            ))
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function isPowerAction(action: ContainerAction): action is Extract<ContainerAction, 'start' | 'stop' | 'restart'> {
  return action === 'start' || action === 'stop' || action === 'restart';
}
