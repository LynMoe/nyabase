import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import {
  Capability,
  PreflightStatus,
  zNodeMetricsPatchConfig,
  type CertificateRotationDto,
  type ConnectServerRequest,
  type IncusClientCertificateDto,
  type IntentAcceptedDto,
  type PatchServerRequest,
  type RunPreflightRequest,
  type ServerPreflightDto,
  type ServerDto,
  type StoragePoolDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { ConnectCard } from '../components/servers/connect-card.js';
import { PreflightCard } from '../components/servers/preflight-card.js';
import { NodeMetricsCard } from '../components/servers/node-metrics-card.js';
import { PoolsCard } from '../components/servers/pools-card.js';
import { CertificateCard } from '../components/servers/certificate-card.js';
import { serverStatusLabel } from '../lib/display-labels.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from '../hooks/use-toast.js';
import { useAuthStore } from '../store/auth.js';
import { ResourceIntentFailures } from '../components/intents/resource-intent-failures.js';
import {
  parseSharedBackendFsidConflict,
  type SharedBackendFsidConflict,
} from '../lib/storage-shrink.js';

const routeApi = getRouteApi('/servers/$id');

export default function ServerDetailPage() {
  const { id } = routeApi.useParams();
  const navigate = useNavigate();
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
  const [fsidConflict, setFsidConflict] = useState<SharedBackendFsidConflict | null>(null);
  const [clearMetricsOpen, setClearMetricsOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const canManageStoragePools = capabilities.includes(Capability.ManageStoragePools);
  const canManageCertificates = capabilities.includes(Capability.ManageCertificates);
  const canManageServers = capabilities.includes(Capability.ManageServers);
  const canViewCertificate = canManageCertificates || canManageServers;

  const serverQuery = useQuery({
    queryKey: queryKeys.servers.detail(id),
    queryFn: () => api.get<ServerDto>(`/admin/servers/${id}`),
  });
  const poolsQuery = useQuery({
    queryKey: queryKeys.servers.pools(id, true),
    queryFn: () => api.get<StoragePoolDto[]>(`/admin/servers/${id}/storage-pools`),
  });
  const preflightQuery = useQuery({
    queryKey: queryKeys.servers.preflight(id),
    queryFn: () => api.get<ServerPreflightDto>(`/admin/servers/${id}/preflight`),
  });
  const certificateQuery = useQuery({
    queryKey: queryKeys.certificate,
    queryFn: () => api.get<IncusClientCertificateDto>('/admin/incus-client-certificate'),
    enabled: canViewCertificate,
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
    void queryClient.invalidateQueries({ queryKey: queryKeys.servers.pools(id, true) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.servers.preflight(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.certificate });
  };

  const connect = useMutation({
    mutationFn: () => {
      const body: ConnectServerRequest = {
        trustToken: trustToken.trim(),
        expectedServerCertFingerprint: (expectedFingerprint || server?.serverCertFingerprint || '').trim(),
      };
      return api.post<IntentAcceptedDto>(`/admin/servers/${id}/connect`, body);
    },
    onSuccess: (intent) => {
      toast({ title: '连接意图已创建', description: `意图 ${intent.intentId.slice(0, 8)} 正在收敛。` });
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
      return api.post<IntentAcceptedDto>(`/admin/servers/${id}/preflight`, body);
    },
    onSuccess: (intent) => {
      toast({ title: '前置检查已开始', description: `意图 ${intent.intentId.slice(0, 8)} 正在执行。` });
      invalidateServer();
    },
    onError: (error) => toast({ title: '前置检查失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const discoverPools = useMutation({
    mutationFn: () => api.post<StoragePoolDto[]>(`/admin/servers/${id}/storage-pools/discover`),
    onSuccess: (pools) => {
      setFsidConflict(null);
      toast({ title: '存储池已刷新', description: `发现 ${pools.length} 个池。` });
      invalidateServer();
    },
    onError: (error) => {
      const conflict = parseSharedBackendFsidConflict(error);
      if (conflict) setFsidConflict(conflict);
      toast({ title: '发现存储池失败', description: errorMessage(error), variant: 'destructive' });
    },
  });

  const updateServer = useMutation({
    mutationFn: (body: PatchServerRequest) => api.patch<ServerDto>(`/admin/servers/${id}`, body),
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
    mutationFn: () => api.delete<void>(`/admin/servers/${id}?expectedRevision=${server?.revision ?? 0}`),
    onSuccess: () => {
      setDeleteOpen(false);
      toast({ title: '服务器已从控制面移除' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.admin });
      void navigate({ to: '/servers' });
    },
    onError: (error) => toast({ title: '删除服务器失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const rotateCertificate = useMutation({
    mutationFn: () => api.post<CertificateRotationDto>('/admin/incus-client-certificate/rotate', {
      expectedGeneration: certificateQuery.data?.generation ?? 0,
    }),
    onSuccess: (result) => {
      setRotateOpen(false);
      toast({ title: '客户端证书轮换已提交', description: `轮换 ${result.rotationId.slice(0, 8)}：${result.status}` });
      invalidateServer();
    },
    onError: (error) => toast({ title: '证书轮换失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const pools = poolsQuery.data ?? [];
  const preflight = preflightQuery.data;
  const selectedPool = pools.find((pool) => pool.id === selectedPoolId);
  const currentSystemPool = server?.systemPoolId ?? '';

  return (
    <Page testId="server-connect-preflight">
      <PageHeader
        title={serverQuery.data?.name ?? '服务器'}
        description={
          serverQuery.data
            ? `${serverQuery.data.slug} · ${serverQuery.data.apiEndpoint}`
            : undefined
        }
        crumbs={[
          { label: '服务器', to: '/servers' },
          { label: serverQuery.data?.name ?? '…' },
        ]}
        actions={
          serverQuery.data ? (
            <>
              <Badge variant={serverQuery.data.status === 'online' ? 'success' : 'secondary'}>
                {serverStatusLabel(serverQuery.data.status)}
              </Badge>
              {canManageServers ? (
                <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
                  <Trash2 className="h-4 w-4" />删除服务器
                </Button>
              ) : null}
            </>
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
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">接入清单</CardTitle>
                <CardDescription>按顺序完成登记、互信、存储池、前置检查，再到 IP 池绑定。</CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="list-decimal space-y-1.5 pl-5 text-sm">
                  <li>登记服务器（已完成）</li>
                  <li>
                    互信
                    {loaded.incusVersion || loaded.serverCertFingerprint
                      ? ' · 已连接'
                      : ' · 在下方粘贴 trust token 并连接'}
                  </li>
                  <li>
                    发现并登记存储池
                    {pools.some((pool) => pool.registered)
                      ? ` · 已登记 ${pools.filter((pool) => pool.registered).length} 个`
                      : ' · 发现后点击登记'}
                  </li>
                  <li>
                    前置检查
                    {loaded.preflightStatus === PreflightStatus.Passed ? ' · 已通过' : ' · 选择探针池与地址后运行'}
                  </li>
                  <li>
                    <Link to="/ip-pools" className="underline">去 IP 池绑定</Link>
                  </li>
                </ol>
              </CardContent>
            </Card>

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
            </div>

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
              fsidConflict={fsidConflict}
              discoverPending={discoverPools.isPending}
              updatePending={updateServer.isPending}
              onSystemPoolIdChange={setSystemPoolId}
              onOvercommitRatioChange={setOvercommitRatio}
              onDismissFsidConflict={() => setFsidConflict(null)}
              onDiscover={() => discoverPools.mutate()}
              onSaveStorage={() => updateServer.mutate({
                expectedRevision: loaded.revision,
                systemPoolId: (systemPoolId || currentSystemPool) || null,
                storageOvercommitRatio: Number(overcommitRatio || loaded.storageOvercommitRatio),
              })}
              onUpdated={invalidateServer}
            />

            <CertificateCard
              serverId={id}
              canViewCertificate={canViewCertificate}
              canManageCertificates={canManageCertificates}
              certificateQuery={canViewCertificate ? certificateQuery : undefined}
              rotatePending={rotateCertificate.isPending}
              rotateOpen={rotateOpen}
              onRotateOpenChange={setRotateOpen}
              onRotate={() => rotateCertificate.mutate()}
            />
            <ResourceIntentFailures listPath={`/admin/servers/${id}/intents`} admin />
          </>
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
