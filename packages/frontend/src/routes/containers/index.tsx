import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Plus, RefreshCw, Server } from 'lucide-react';
import type { ContainerAction, ContainerDto, IntentAcceptedDto, UserServerDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { ContainerRow } from '../../components/containers/container-row.js';
import { CreateContainerDialog } from '../../components/containers/create-container-dialog.js';
import { QueryErrorState, QueryLoadingState } from '../../components/query-state.js';
import { queryKeys } from '../../lib/query-keys.js';
import { actionProgressHint, containerActionSubmittedTitle, serverStatusLabel } from '../../lib/status-labels.js';
import { toast } from '../../hooks/use-toast.js';

function ContainersPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [defaultServerId, setDefaultServerId] = useState<string | undefined>();
  const serversQuery = useQuery({ queryKey: queryKeys.servers.user, queryFn: () => api.get<UserServerDto[]>('/servers') });
  const containersQuery = useQuery({ queryKey: queryKeys.containers.userList, queryFn: () => api.get<ContainerDto[]>('/containers'), refetchInterval: 5_000 });
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
    onError: (error) => toast({ title: '容器操作失败', description: error instanceof Error ? error.message : '请稍后重试', variant: 'destructive' }),
  });
  const containers = containersQuery.data ?? [];
  const grouped = useMemo(() => {
    const map = new Map<string, ContainerDto[]>();
    for (const container of containers) map.set(container.serverId, [...(map.get(container.serverId) ?? []), container]);
    return map;
  }, [containers]);

  if (serversQuery.isLoading || containersQuery.isLoading) return <QueryLoadingState label="加载容器..." />;
  if (serversQuery.isError) return <QueryErrorState error={serversQuery.error} resourceName="服务器" onRetry={() => { void serversQuery.refetch(); }} />;
  if (containersQuery.isError) return <QueryErrorState error={containersQuery.error} resourceName="容器" onRetry={() => { void containersQuery.refetch(); }} />;
  const servers = serversQuery.data ?? [];

  return (
    <div className="space-y-5 px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">容器</h1>
          <p className="text-sm text-muted-foreground">{containers.length} 个容器 · 运行时状态来自后端观测</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={() => { void Promise.all([serversQuery.refetch(), containersQuery.refetch()]); }} aria-label="刷新容器">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => { setDefaultServerId(undefined); setCreateOpen(true); }}>
            <Plus className="h-4 w-4" />新建容器
          </Button>
        </div>
      </div>
      {servers.length === 0 && containers.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">暂无可访问的服务器或容器。</CardContent></Card>
      ) : (
        <div className="space-y-5">
          {servers.map((server) => (
            <ServerContainerGroup
              key={server.id}
              server={server}
              containers={grouped.get(server.id) ?? []}
              onCreate={() => { setDefaultServerId(server.id); setCreateOpen(true); }}
              onAction={(actionName, container) => {
                if (isPowerAction(actionName)) action.mutate({ actionName, containerId: container.id });
              }}
              actionPending={action.isPending}
            />
          ))}
          {containers
            .filter((container) => !servers.some((server) => server.id === container.serverId))
            .map((container) => (
              <Card key={container.id}>
                <ContainerRow
                  container={container}
                  actionPending={action.isPending}
                  onAction={(actionName, item) => {
                    if (isPowerAction(actionName)) action.mutate({ actionName, containerId: item.id });
                  }}
                />
              </Card>
            ))}
        </div>
      )}
      <CreateContainerDialog open={createOpen} onOpenChange={setCreateOpen} defaultServerId={defaultServerId} />
    </div>
  );
}

function ServerContainerGroup({
  server,
  containers,
  onCreate,
  onAction,
  actionPending,
}: {
  server: UserServerDto;
  containers: ContainerDto[];
  onCreate: () => void;
  onAction: (action: ContainerAction, container: ContainerDto) => void;
  actionPending: boolean;
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
        <Button size="sm" variant="outline" onClick={onCreate}><Plus className="h-4 w-4" />新建</Button>
      </div>
      <Card>
        <CardContent className="divide-y p-0">
          {containers.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">该服务器暂无容器。</p>
          ) : (
            containers.map((container) => (
              <ContainerRow key={container.id} container={container} onAction={onAction} actionPending={actionPending} />
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

export const Route = createFileRoute('/containers/')({ component: ContainersPage });
