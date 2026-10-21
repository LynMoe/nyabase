import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { Activity, Cpu, Gauge, HardDrive, History, KeyRound, ListChecks, Trash2 } from 'lucide-react';
import {
  Capability,
  zNodeMetricsPatchConfig,
  type ConnectServerRequest,
  type IntentAcceptedDto,
  type PatchServerRequest,
  type RunPreflightRequest,
  type ServerPreflightDto,
  type ServerDto,
  type StoragePoolDiscoverResult,
  type StoragePoolDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Badge } from '../components/ui/badge.js';
import { MoreActions } from '../components/layout/more-actions.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { ConnectCard } from '../components/servers/connect-card.js';
import { PreflightCard } from '../components/servers/preflight-card.js';
import { NodeMetricsCard } from '../components/servers/node-metrics-card.js';
import { ServerMetricsPanel } from '../components/performance/server-metrics-panel.js';
import { PoolsCard } from '../components/servers/pools-card.js';
import { ServerStorageTab } from '../components/servers/server-storage-tab.js';
import { TechnicalId } from '../components/refs/technical-id.js';
import { preflightStatusLabel, serverStatusLabel, storageOvercommitLabel } from '../lib/display-labels.js';
import {
  preflightPending,
} from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { toast } from '../hooks/use-toast.js';
import { useAuthStore } from '../store/auth.js';
import { ResourceIntentFailures } from '../components/intents/resource-intent-failures.js';
import { ServerGpuCard } from '../components/gpu/gpu-sections.js';
import { Field } from '../components/layout/field.js';

const routeApi = getRouteApi('/servers/$id');

export const SERVER_DETAIL_TABS = [
  'overview', 'connect', 'storage', 'preflight', 'metrics', 'gpu', 'activity',
] as const;
export type ServerDetailTab = (typeof SERVER_DETAIL_TABS)[number];

const SERVER_DETAIL_TAB_ITEMS = [
  ['overview', '概览', Gauge],
  ['connect', '接入', KeyRound],
  ['storage', '存储', HardDrive],
  ['preflight', '检查', ListChecks],
  ['metrics', '监控', Activity],
  ['gpu', 'GPU', Cpu],
  ['activity', '活动', History],
] as const;

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
  const [trustToken, setTrustToken] = useState('');
  const [expectedFingerprint, setExpectedFingerprint] = useState('');
  const [probeAddress, setProbeAddress] = useState('');
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const [systemPoolId, setSystemPoolId] = useState('');
  const [overcommitRatio, setOvercommitRatio] = useState('');
  const [nodeMetricsEndpoint, setNodeMetricsEndpoint] = useState('');
  const [nodeMetricsCertFingerprint, setNodeMetricsCertFingerprint] = useState('');
  const [nodeMetricsToken, setNodeMetricsToken] = useState('');
  const [clearMetricsOpen, setClearMetricsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const canManageStoragePools = capabilities.includes(Capability.ManageStoragePools);
  const canManageServers = capabilities.includes(Capability.ManageServers);
  const canViewMetrics = capabilities.includes(Capability.ViewMetricsAll);

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

  useEffect(() => {
    if (!server) return;
    setNodeMetricsEndpoint(server.nodeMetrics.endpoint ?? '');
    setNodeMetricsCertFingerprint(server.nodeMetrics.serverCertFingerprint ?? '');
    setNodeMetricsToken('');
  }, [server?.id, server?.revision]);

  const invalidateServer = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.servers.detail(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.servers.pools(id, 'all') });
    void queryClient.invalidateQueries({ queryKey: queryKeys.servers.preflight(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.certificate });
    void queryClient.invalidateQueries({ queryKey: queryKeys.sharedBackends.admin });
  };

  const connect = useMutation({
    mutationFn: () => {
      const body: ConnectServerRequest = {
        trustToken: trustToken.trim(),
        expectedServerCertFingerprint: (expectedFingerprint || server?.serverCertFingerprint || '').trim(),
      };
      return api.post<IntentAcceptedDto>(`/servers/${id}/connect`, body);
    },
    onSuccess: (intent) => {
      toast({ title: '已开始连接服务器', description: `操作 ${intent.intentId.slice(0, 8)} 正在执行。` });
      setTrustToken('');
      invalidateServer();
    },
    onError: (error) => toast({ title: '连接失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const runPreflight = useMutation({
    mutationFn: () => {
      const body: RunPreflightRequest = {
        expectedServerRevision: server?.revision ?? 0,
        poolId: selectedPoolId,
        probeAddress: probeAddress.trim(),
      };
      return api.post<IntentAcceptedDto>(`/servers/${id}/preflight`, body);
    },
    onSuccess: (intent) => {
      toast({ title: '前置检查已开始', description: `操作 ${intent.intentId.slice(0, 8)} 正在执行。` });
      invalidateServer();
    },
    onError: (error) => toast({ title: '前置检查失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const discoverPools = useMutation({
    mutationFn: () => api.post<StoragePoolDiscoverResult>(`/servers/${id}/storage-pools/discover`),
    onSuccess: (result) => {
      toast({ title: '存储池已刷新', description: `发现 ${result.pools.length} 个本地池。` });
      invalidateServer();
    },
    onError: (error) => {
      toast({ title: '发现存储池失败', description: errorMessage(error), variant: 'destructive' });
    },
  });

  const updateServer = useMutation({
    mutationFn: (body: PatchServerRequest) => api.patch<ServerDto>(`/servers/${id}`, body),
    onSuccess: () => {
      setClearMetricsOpen(false);
      toast({ title: '服务器设置已更新' });
      invalidateServer();
    },
    onError: (error) => toast({ title: '更新失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const saveNodeMetrics = () => {
    if (!server) return;
    const token = nodeMetricsToken.trim();
    if (!nodeMetricsEndpoint.trim() || !nodeMetricsCertFingerprint.trim()) {
      toast({
        title: 'node-exporter 配置不完整',
        description: 'endpoint 和证书 pin 都是必填项。',
        variant: 'destructive',
      });
      return;
    }
    if (!server.nodeMetrics.tokenFingerprint && token.length === 0) {
      toast({
        title: '需要首次配置 token',
        description: '首次配置必须输入 token；已配置时留空可保持原 token。',
        variant: 'destructive',
      });
      return;
    }
    const parsed = zNodeMetricsPatchConfig.safeParse({
      endpoint: nodeMetricsEndpoint.trim(),
      serverCertFingerprint: nodeMetricsCertFingerprint.trim(),
      ...(token.length > 0 ? { token } : {}),
    });
    if (!parsed.success) {
      toast({
        title: 'node-exporter 配置无效',
        description: parsed.error.issues[0]?.message ?? '请检查 endpoint、证书 pin 和 token。',
        variant: 'destructive',
      });
      return;
    }
    updateServer.mutate({
      expectedRevision: server.revision,
      nodeMetrics: parsed.data,
    });
  };

  const clearNodeMetrics = () => {
    if (!server) return;
    updateServer.mutate({
      expectedRevision: server.revision,
      nodeMetrics: null,
    });
  };

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

  const pools = poolsQuery.data ?? [];
  const preflight = preflightQuery.data;
  const selectedPool = pools.find((pool) => pool.id === selectedPoolId);
  const currentSystemPool = server?.systemPoolId ?? '';
  const registeredPoolCount = pools.filter((pool) => pool.registered).length;

  return (
    <Page testId="server-connect-preflight">
      <PageHeader
        title={serverQuery.data ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>{serverQuery.data.name}</span>
            <Badge variant={serverQuery.data.status === 'online' ? 'success' : 'secondary'} title={serverQuery.data.status}>
              {serverStatusLabel(serverQuery.data.status)}
            </Badge>
          </span>
        ) : '服务器'}
        crumbs={[
          { label: '服务器', to: '/servers' },
          { label: serverQuery.data?.name ?? '…' },
        ]}
        actions={
          serverQuery.data && canManageServers ? (
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
          <Tabs
            value={tab}
            onValueChange={(value) => selectTab(value as ServerDetailTab)}
            data-testid="server-detail-tabs"
          >
            <TabsList>
              {SERVER_DETAIL_TAB_ITEMS.map(([key, label, Icon]) => (
                <TabsTrigger key={key} value={key} className="gap-1.5" data-testid={`server-tab-${key}`}>
                  <Icon className="h-4 w-4" />{label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="overview" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">身份</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
                  <Field label="slug" value={<TechnicalId label="slug" value={loaded.slug} kind="text" />} />
                  <Field label="接入地址" value={<TechnicalId label="接入地址" value={loaded.apiEndpoint} kind="text" />} />
                  <Field label="Incus 版本" value={loaded.incusVersion ?? '未连接'} />
                  <Field label="系统盘池" value={loaded.systemPoolName ?? loaded.systemPoolId ?? '未指定'} />
                  <Field label="存储超分比例" value={storageOvercommitLabel(loaded.storageOvercommitRatio)} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">接入清单</CardTitle>
                </CardHeader>
                <CardContent>
                  <ol className="list-decimal space-y-1.5 pl-5 text-sm">
                    <li>
                      <button type="button" className="underline" onClick={() => selectTab('connect')}>互信</button>
                      {loaded.incusVersion || loaded.serverCertFingerprint ? ' · 已连接' : ' · 未连接'}
                    </li>
                    <li>
                      <button type="button" className="underline" onClick={() => selectTab('storage')}>存储池</button>
                      {` · 已登记 ${registeredPoolCount} 个`}
                    </li>
                    <li>
                      <button type="button" className="underline" onClick={() => selectTab('preflight')}>前置检查</button>
                      {` · ${preflightStatusLabel(loaded.preflightStatus)}`}
                    </li>
                    <li>
                      <Link to="/ip-pools" className="underline">IP 池</Link>
                      {' · 在 IP 池页把地址段绑定到这台服务器'}
                    </li>
                  </ol>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="connect" className="space-y-6">
              <div className="grid items-start gap-4 xl:grid-cols-2">
                <ConnectCard
                  server={loaded}
                  trustToken={trustToken}
                  expectedFingerprint={expectedFingerprint}
                  connectPending={connect.isPending}
                  onTrustTokenChange={setTrustToken}
                  onExpectedFingerprintChange={setExpectedFingerprint}
                  onConnect={() => connect.mutate()}
                />
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">客户端证书</CardTitle>
                    <CardDescription>
                      所有服务器共用一张 Incus 客户端证书，在
                      <Link to="/servers" hash="client-certificate" className="mx-1 underline underline-offset-4">服务器列表</Link>
                      统一查看与轮换。
                    </CardDescription>
                  </CardHeader>
                </Card>
              </div>
            </TabsContent>
            <TabsContent value="storage" className="space-y-6" data-testid="server-storage-tab">
              <ServerStorageTab serverId={id} pools={pools}>
                <PoolsCard
                  pools={pools}
                  poolsError={poolsQuery.isError ? poolsQuery.error : null}
                  onRetryPools={() => { void poolsQuery.refetch(); }}
                  canManageStoragePools={canManageStoragePools}
                  selectedPool={selectedPool}
                  systemPoolId={systemPoolId}
                  currentSystemPool={currentSystemPool}
                  overcommitRatio={overcommitRatio}
                  storageOvercommitRatio={loaded.storageOvercommitRatio}
                  discoverPending={discoverPools.isPending}
                  updatePending={updateServer.isPending}
                  onSystemPoolIdChange={setSystemPoolId}
                  onOvercommitRatioChange={setOvercommitRatio}
                  onDiscover={() => discoverPools.mutate()}
                  onSaveStorage={() => updateServer.mutate({
                    expectedRevision: loaded.revision,
                    systemPoolId: (systemPoolId || currentSystemPool) || null,
                    storageOvercommitRatio: Number(overcommitRatio || loaded.storageOvercommitRatio),
                  })}
                  onUpdated={invalidateServer}
                />
              </ServerStorageTab>
            </TabsContent>
            <TabsContent value="preflight">
              <PreflightCard
                pools={pools}
                selectedPoolId={selectedPoolId}
                probeAddress={probeAddress}
                preflightPending={runPreflight.isPending}
                status={preflight?.status ?? loaded.preflightStatus}
                report={preflight?.report ?? loaded.preflightReport}
                onSelectedPoolIdChange={setSelectedPoolId}
                onProbeAddressChange={setProbeAddress}
                onRunPreflight={() => runPreflight.mutate()}
              />
            </TabsContent>
            <TabsContent value="metrics" className="space-y-6">
              {canViewMetrics ? <ServerMetricsPanel serverId={id} /> : null}
              <NodeMetricsCard
                server={loaded}
                endpoint={nodeMetricsEndpoint}
                certFingerprint={nodeMetricsCertFingerprint}
                token={nodeMetricsToken}
                updatePending={updateServer.isPending}
                clearOpen={clearMetricsOpen}
                onEndpointChange={setNodeMetricsEndpoint}
                onCertFingerprintChange={setNodeMetricsCertFingerprint}
                onTokenChange={setNodeMetricsToken}
                onSave={saveNodeMetrics}
                onClear={clearNodeMetrics}
                onClearOpenChange={setClearMetricsOpen}
              />
            </TabsContent>
            <TabsContent value="gpu">
              {canManageServers ? (
                <ServerGpuCard serverId={id} active={tab === 'gpu'} />
              ) : (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">GPU</CardTitle>
                    <CardDescription>没有管理此服务器 GPU 的权限</CardDescription>
                  </CardHeader>
                </Card>
              )}
            </TabsContent>
            <TabsContent value="activity">
              <ResourceIntentFailures
                listPath={`/intents?scope=all&serverId=${id}`}
                enabled={tab === 'activity'}
              />
            </TabsContent>
          </Tabs>
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

