import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { Button, buttonVariants } from '../../components/ui/button.js';
import { Separator } from '../../components/ui/separator.js';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '../../components/ui/alert-dialog.js';
import { Plus, Container, RefreshCw, Server } from 'lucide-react';
import type { ContainerView, UserServerDto } from '@nyabase/common';
import { ContainerRow } from '../../components/containers/container-row.js';
import { CreateContainerDialog } from '../../components/containers/create-container-dialog.js';
import { useContainerActions } from '../../hooks/use-container-actions.js';
import { cn } from '../../lib/utils.js';
import { queryKeys } from '../../lib/query-keys.js';
import { QueryErrorState } from '../../components/query-state.js';
import { queryPollInterval } from '../../lib/query-lifecycle.js';

function ServerContainersSection({
  server,
  items,
  onCreate,
  onAction,
}: {
  server: UserServerDto;
  items: ContainerView[];
  onCreate: () => void;
  onAction: (action: import('@nyabase/common').ContainerAction, containerId: string, name: string) => void;
}) {
  const online = server.status === 'online';
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-muted-foreground" />
          <span className="font-semibold text-foreground">{server.name}</span>
          <span
            className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
              online ? 'bg-green-50 text-green-700' : 'bg-muted text-muted-foreground'
            }`}
          >
            {online ? '在线' : '离线'}
          </span>
          <span className="text-xs text-muted-foreground">{items.length} 个容器</span>
        </div>
        <Button size="sm" variant="outline" onClick={onCreate}>
          <Plus className="h-4 w-4" />
          新建
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="bg-card rounded-lg border border-dashed px-5 py-6 text-center">
          <Container className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
          <div className="text-sm text-muted-foreground">该服务器暂无容器</div>
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            {items.map((c, i) => (
              <div key={c.id}>
                <ContainerRow
                  container={c}
                  onAction={onAction}
                />
                {i < items.length - 1 && <Separator />}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function OrphanContainersSection({
  serverName,
  items,
  onAction,
}: {
  serverName: string;
  items: ContainerView[];
  onAction: (action: import('@nyabase/common').ContainerAction, containerId: string, name: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Server className="h-4 w-4 text-muted-foreground" />
        <span className="font-semibold text-foreground">{serverName}</span>
        <span className="text-xs text-muted-foreground">{items.length} 个容器</span>
        <span className="text-xs text-muted-foreground/60">（已不在服务器列表中）</span>
      </div>
      <Card>
        <CardContent className="p-0">
          {items.map((c, i) => (
            <div key={c.id}>
              <ContainerRow
                container={c}
                onAction={onAction}
              />
              {i < items.length - 1 && <Separator />}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function ContainersPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [createDefaultServerId, setCreateDefaultServerId] = useState<string | undefined>();
  const qc = useQueryClient();

  const { doAction, confirmState, handleConfirm, handleCancel } =
    useContainerActions();

  const serversQuery = useQuery({
    queryKey: queryKeys.servers.user,
    queryFn: () => api.get<UserServerDto[]>('/servers'),
  });
  const servers = serversQuery.data ?? [];
  const { isLoading: serversLoading, isFetching: serversFetching } = serversQuery;

  const containersQuery = useQuery({
    queryKey: queryKeys.containers.userList,
    queryFn: () => api.get<ContainerView[]>('/v2/containers'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 8_000 }),
  });
  const containers = containersQuery.data ?? [];
  const { isLoading: containersLoading, isFetching, refetch } = containersQuery;

  const orphanGroups = useMemo(() => {
    const known = new Set(servers.map((s) => s.id));
    const m = new Map<string, ContainerView[]>();
    for (const c of containers) {
      if (known.has(c.serverId)) continue;
      const arr = m.get(c.serverId);
      if (arr) arr.push(c);
      else m.set(c.serverId, [c]);
    }
    return [...m.entries()];
  }, [servers, containers]);

  const listLoading = serversLoading || containersLoading;
  const isRefreshing = isFetching || serversFetching;

  const handleRefresh = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.servers.user });
    void refetch();
  };

  const openCreate = (serverId?: string) => {
    const canUseServer = serverId !== undefined && servers.some((server) => server.id === serverId && server.status === 'online');
    setCreateDefaultServerId(canUseServer ? serverId : undefined);
    setShowCreate(true);
  };

  const onCreateOpenChange = (open: boolean) => {
    setShowCreate(open);
    if (!open) setCreateDefaultServerId(undefined);
  };

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">容器</h1>
          <p className="text-muted-foreground text-sm">
            {containersQuery.data ? `${containers.length} 个容器` : '容器数量尚未加载'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={handleRefresh} disabled={isRefreshing}>
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </Button>
          <Button onClick={() => openCreate()}>
            <Plus className="h-4 w-4" />新建容器
          </Button>
        </div>
      </div>

      {listLoading ? (
        <Card><CardContent className="h-32 animate-pulse bg-muted/50 rounded-lg mt-6" /></Card>
      ) : serversQuery.isError || containersQuery.isError ? (
        <QueryErrorState
          error={serversQuery.error ?? containersQuery.error}
          resourceName="容器与服务器目录"
          onRetry={() => { void Promise.all([serversQuery.refetch(), containersQuery.refetch()]); }}
        />
      ) : servers.length === 0 && containers.length === 0 ? (
        <div className="bg-card rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          暂无可访问的服务器。请联系管理员为你分配服务器和镜像权限。
        </div>
      ) : (
        <div className="space-y-6">
          {servers.map((s) => {
            const items = containers.filter((c) => c.serverId === s.id);
            return (
              <ServerContainersSection
                key={s.id}
                server={s}
                items={items}
                onCreate={() => openCreate(s.id)}
                onAction={doAction}
              />
            );
          })}
          {orphanGroups.map(([serverId, items]) => (
            <OrphanContainersSection
              key={serverId}
              serverName={items[0]?.serverName ?? serverId}
              items={items}
              onAction={doAction}
            />
          ))}
        </div>
      )}

      <CreateContainerDialog
        open={showCreate}
        onOpenChange={onCreateOpenChange}
        defaultServerId={createDefaultServerId}
      />

      <AlertDialog open={!!confirmState} onOpenChange={(open) => { if (!open) handleCancel(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmState?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmState?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancel}>取消</AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                confirmState?.variant === 'destructive' && buttonVariants({ variant: 'destructive' }),
              )}
              onClick={() => void handleConfirm()}
            >
              {confirmState?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export const Route = createFileRoute('/containers/')({ component: ContainersPage });
