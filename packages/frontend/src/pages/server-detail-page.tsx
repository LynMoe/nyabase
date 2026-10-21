import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { Capability, type ServerDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
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
import { useAuthStore } from '../store/auth.js';
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
  const canManageServers = useAuthStore(
    (state) => state.user?.capabilities.includes(Capability.ManageServers) ?? false,
  );

  const serverQuery = useQuery({
    queryKey: queryKeys.servers.detail(id),
    queryFn: () => api.get<ServerDto>(`/servers/${id}?scope=all`),
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (server) => !preflightPending(server.preflightStatus),
    }),
  });
  const server = serverQuery.data;
  const deleteServer = useMutation({
    mutationFn: () => api.delete<void>(`/servers/${id}?expectedRevision=${server?.revision ?? 0}`),
    onSuccess: () => {
      setDeleteOpen(false);
      toast({ title: '服务器已从控制面移除' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.admin });
      void navigate({ to: '/servers' });
    },
    onError: (error) => toast({ title: '删除服务器失败', description: errorMessage(error), variant: 'destructive' }),
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
        title="从控制面删除这台服务器？"
        description="只会清除控制面上这台服务器的对象（容器记录、本机卷、本机 catalog）。不会对这台 Incus 做任何删除。共享卷若还登记在其他服务器上会保留；若只登记在这台上，控制面卷行会消失，Ceph 目录可能残留。重新加入按全新空白服务器处理。"
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={deleteServer.isPending}
        onConfirm={() => deleteServer.mutate()}
        onOpenChange={setDeleteOpen}
      />
    </Page>
  );
}
