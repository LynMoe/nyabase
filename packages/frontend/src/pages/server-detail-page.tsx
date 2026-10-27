import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { Role, type ServerDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { ApiError, apiErrorDetails, errorMessage } from '../lib/api-error.js';
import { toast } from '../hooks/use-toast.js';
import { Badge } from '../components/ui/badge.js';
import { MoreActions } from '../components/layout/more-actions.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { serverStatusLabel } from '../lib/display-labels.js';
import { preflightPending } from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { useHasRole } from '../lib/use-role.js';
import {
  SERVER_DETAIL_TABS,
  type ServerDetailTab,
  ServerDetailTabs,
} from './server-detail-page/server-tabs.js';

const routeApi = getRouteApi('/servers/$id');

export { SERVER_DETAIL_TABS, type ServerDetailTab };

export function parseServerDetailTab(value: unknown): ServerDetailTab {
  return SERVER_DETAIL_TABS.includes(value as ServerDetailTab)
    ? (value as ServerDetailTab)
    : 'overview';
}

export default function ServerDetailPage() {
  const { id } = routeApi.useParams();
  const { tab } = routeApi.useSearch();
  const navigate = useNavigate({ from: '/servers/$id' });
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  /** Set once the server refused because it still holds resources or is a shared backend's last executor. */
  const [heldResources, setHeldResources] = useState<HeldResources | null>(null);
  const canManageServers = useHasRole(Role.Admin);

  const serverQuery = useQuery({
    queryKey: queryKeys.servers.detail(id),
    queryFn: () => api.get<ServerDto>(`/servers/${id}?scope=all`),
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      // Also poll while an issued enrollment token waits for the agent to dial in.
      isSettled: (server) => !preflightPending(server.preflightStatus)
        && (server.agent.connected
          || server.agent.enrollmentExpiresAt === null
          || Date.parse(server.agent.enrollmentExpiresAt) <= Date.now()),
    }),
  });
  const server = serverQuery.data;
  const deleteServer = useMutation({
    mutationFn: (force: boolean) =>
      api.delete<void>(`/servers/${id}?expectedRevision=${server?.revision ?? 0}${force ? '&force=true' : ''}`),
    onSuccess: () => {
      setDeleteOpen(false);
      setHeldResources(null);
      toast({ title: '服务器已从控制面移除' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.admin });
      void navigate({ to: '/servers' });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'SERVER_NOT_EMPTY') {
        const details = apiErrorDetails(error);
        setHeldResources({
          containers: Number(details?.containers ?? 0),
          localVolumes: Number(details?.localVolumes ?? 0),
          strandedSharedVolumes: Number(details?.strandedSharedVolumes ?? 0),
        });
        return;
      }
      toast({ title: '删除服务器失败', description: errorMessage(error), variant: 'destructive' });
    },
  });

  return (
    <Page testId="server-connect-preflight">
      <PageHeader
        title={server ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>{server.name}</span>
            <Badge variant={server.status === 'online' ? 'success' : 'secondary'} title={server.status}>
              {serverStatusLabel(server.status)}
            </Badge>
          </span>
        ) : '服务器'}
        crumbs={[
          { label: '服务器', to: '/servers' },
          { label: server?.name ?? '…' },
        ]}
        actions={
          server && canManageServers ? (
            <MoreActions actions={[{ label: '从控制面删除', icon: Trash2, destructive: true, onSelect: () => setDeleteOpen(true) }]} />
          ) : undefined
        }
      />
      <QueryView
        query={serverQuery}
        resourceName="服务器"
        loadingLabel="加载服务器..."
        onBack={() => window.history.back()}
      >
        {(loaded) => (
          <ServerDetailTabs
            server={loaded}
            tab={tab}
            onSelectTab={(next) => { void navigate({ search: (prev) => ({ ...prev, tab: next }) }); }}
          />
        )}
      </QueryView>
      <ConfirmDialog
        open={deleteOpen}
        title={heldResources ? '强制从控制面删除这台服务器？' : '从控制面删除这台服务器？'}
        description={heldResources
          ? heldResourcesDescription(heldResources)
          : '不会删除主机上的任何内容。'}
        confirmLabel={heldResources ? '主机已永久下线，强制删除' : '确认删除'}
        pendingLabel="删除中..."
        pending={deleteServer.isPending}
        onConfirm={() => deleteServer.mutate(heldResources !== null)}
        onOpenChange={(open) => {
          setDeleteOpen(open);
          if (!open) setHeldResources(null);
        }}
      />
    </Page>
  );
}

interface HeldResources {
  readonly containers: number;
  readonly localVolumes: number;
  readonly strandedSharedVolumes: number;
}

function heldResourcesDescription(held: HeldResources): string {
  const parts: string[] = [];
  if (held.containers > 0 || held.localVolumes > 0) {
    parts.push(`还有 ${held.containers} 个容器、${held.localVolumes} 个本机卷。仅在主机已永久下线时强制删除，否则其 IP 会被重新分配而冲突。`);
  }
  if (held.strandedSharedVolumes > 0) {
    parts.push(`它是 ${held.strandedSharedVolumes} 个共享卷的最后一台执行器，强制删除后在新执行器登记前无法挂载或删除这些卷。`);
  }
  return parts.join(' ');
}
