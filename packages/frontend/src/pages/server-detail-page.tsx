import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import {
  Capability,
  type ServerDto,
  type ServerPreflightDto,
  type StoragePoolDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { Badge } from '../components/ui/badge.js';
import { MoreActions } from '../components/layout/more-actions.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { serverStatusLabel } from '../lib/display-labels.js';
import { preflightPending } from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { useAuthStore } from '../store/auth.js';
import {
  ServerDetailTabs,
  SERVER_DETAIL_TABS,
  type ServerDetailTab,
  type ServerFormState,
} from './server-detail-page/server-tabs.js';
import { useNodeMetricsForm } from './server-detail-page/use-server-detail.js';
import { useServerActions } from './server-detail-page/use-server-detail.js';

const routeApi = getRouteApi('/servers/$id');

export { SERVER_DETAIL_TABS, type ServerDetailTab };

export function parseServerDetailTab(value: unknown): ServerDetailTab {
  return SERVER_DETAIL_TABS.includes(value as ServerDetailTab)
    ? (value as ServerDetailTab)
    : 'overview';
}

/** Form values live here, not in the tabs, so they survive switching tabs. */
function useServerFormState(): ServerFormState {
  const [trustToken, setTrustToken] = useState('');
  const [expectedFingerprint, setExpectedFingerprint] = useState('');
  const [probeAddress, setProbeAddress] = useState('');
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const [systemPoolId, setSystemPoolId] = useState('');
  const [overcommitRatio, setOvercommitRatio] = useState('');
  return {
    trustToken,
    expectedFingerprint,
    probeAddress,
    selectedPoolId,
    systemPoolId,
    overcommitRatio,
    setTrustToken,
    setExpectedFingerprint,
    setProbeAddress,
    setSelectedPoolId,
    setSystemPoolId,
    setOvercommitRatio,
  };
}

export default function ServerDetailPage() {
  const { id } = routeApi.useParams();
  const { tab } = routeApi.useSearch();
  const navigate = useNavigate({ from: '/servers/$id' });
  const forms = useServerFormState();
  const [clearMetricsOpen, setClearMetricsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const canManageServers = capabilities.includes(Capability.ManageServers);

  const selectTab = (next: ServerDetailTab) => {
    void navigate({ search: (prev) => ({ ...prev, tab: next }) });
  };

  const serverQuery = useQuery({
    queryKey: queryKeys.servers.detail(id),
    queryFn: () => api.get<ServerDto>(`/servers/${id}?scope=all`),
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (server) => !preflightPending(server.preflightStatus),
    }),
  });
  const poolsQuery = useQuery({
    queryKey: queryKeys.servers.pools(id, 'all'),
    queryFn: () => api.get<StoragePoolDto[]>(`/servers/${id}/storage-pools?scope=all`),
  });
  const preflightQuery = useQuery({
    queryKey: queryKeys.servers.preflight(id),
    queryFn: () => api.get<ServerPreflightDto>(`/servers/${id}/preflight`),
    enabled: tab === 'preflight',
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (report) => !preflightPending(report.status),
    }),
  });
  const server = serverQuery.data;

  const actions = useServerActions({
    id,
    server,
    form: forms,
    onConnectSubmitted: () => forms.setTrustToken(''),
    onSettingsSaved: () => setClearMetricsOpen(false),
    onDeleted: () => setDeleteOpen(false),
  });
  const nodeMetrics = useNodeMetricsForm(server, actions.updateServer);

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
            serverId={id}
            tab={tab}
            onSelectTab={selectTab}
            forms={forms}
            actions={actions}
            nodeMetrics={nodeMetrics}
            clearMetricsOpen={clearMetricsOpen}
            onClearMetricsOpenChange={setClearMetricsOpen}
            poolsQuery={poolsQuery}
            preflight={preflightQuery.data}
            canManageStoragePools={capabilities.includes(Capability.ManageStoragePools)}
            canManageServers={canManageServers}
            canViewMetrics={capabilities.includes(Capability.ViewMetricsAll)}
          />
        )}
      </QueryView>
      <ConfirmDialog
        open={deleteOpen}
        title="从控制面删除这台服务器？"
        description="只会清除控制面上这台服务器的对象（容器记录、本机卷、本机 catalog）。不会对这台 Incus 做任何删除。共享卷若还登记在其他服务器上会保留；若只登记在这台上，控制面卷行会消失，Ceph 目录可能残留。重新加入按全新空白服务器处理。"
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={actions.deleteServer.isPending}
        onConfirm={() => actions.deleteServer.mutate()}
        onOpenChange={setDeleteOpen}
      />
    </Page>
  );
}
