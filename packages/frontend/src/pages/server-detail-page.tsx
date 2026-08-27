import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import {
  Activity,
  ArrowLeft,
  KeyRound,
  Play,
  RefreshCw,
  RotateCw,
  Server,
  ShieldCheck,
} from 'lucide-react';
import {
  Capability,
  CertificateTrustState,
  NodeMetricsStatus,
  PreflightStatus,
  zNodeMetricsPatchConfig,
  type CertificateRotationDto,
  type ConnectServerRequest,
  type IncusClientCertificateDto,
  type IntentAcceptedDto,
  type PatchServerRequest,
  type PreflightReport,
  type RunPreflightRequest,
  type ServerPreflightDto,
  type ServerDto,
  type StoragePoolDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
import { FsidConflictAlert } from '../components/storage/fsid-conflict-alert.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../components/ui/alert-dialog.js';
import {
  nodeMetricsStatusZh,
  preflightCheckLabel,
  preflightResultLabel,
  preflightStatusLabel,
  serverStatusLabel,
} from '../lib/display-labels.js';
import { relativeTime, usedTotalLabel } from '../lib/utils.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from '../hooks/use-toast.js';
import { useAuthStore } from '../store/auth.js';
import { ResourceIntentFailures } from '../components/intents/resource-intent-failures.js';
import {
  certExpiryWarning,
  formatCertRemainingLabel,
} from '../lib/cert-expiry.js';
import {
  parseSharedBackendFsidConflict,
  type SharedBackendFsidConflict,
} from '../lib/storage-shrink.js';

const routeApi = getRouteApi('/servers/$id');

export default function ServerDetailPage() {
  const { id } = routeApi.useParams();
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
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const canManageStoragePools = capabilities.includes(Capability.ManageStoragePools);
  const canManageCertificates = capabilities.includes(Capability.ManageCertificates);
  const canViewCertificate = canManageCertificates || capabilities.includes(Capability.ManageServers);

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
    queryKey: ['incus-client-certificate'],
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
    void queryClient.invalidateQueries({ queryKey: ['incus-client-certificate'] });
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

  const rotateCertificate = useMutation({
    mutationFn: () => api.post<CertificateRotationDto>('/admin/incus-client-certificate/rotate', {
      expectedGeneration: certificateQuery.data?.generation ?? 0,
    }),
    onSuccess: (result) => {
      toast({ title: '客户端证书轮换已提交', description: `轮换 ${result.rotationId.slice(0, 8)}：${result.status}` });
      invalidateServer();
    },
    onError: (error) => toast({ title: '证书轮换失败', description: errorMessage(error), variant: 'destructive' }),
  });

  if (serverQuery.isLoading) return <QueryLoadingState label="加载服务器..." />;
  if (serverQuery.isError) {
    return <QueryErrorState error={serverQuery.error} resourceName="服务器" onRetry={() => { void serverQuery.refetch(); }} onBack={() => window.history.back()} />;
  }
  if (!server) return null;
  const pools = poolsQuery.data ?? [];
  const preflight = preflightQuery.data;
  const certificate = certificateQuery.data;
  const selectedPool = pools.find((pool) => pool.id === selectedPoolId);
  const currentSystemPool = server.systemPoolId ?? '';

  return (
    <div className="space-y-5 px-4 py-4 md:px-6" data-testid="server-connect-preflight">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Link to="/servers"><Button variant="outline" size="icon" aria-label="返回服务器"><ArrowLeft className="h-4 w-4" /></Button></Link>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{server.name}</h1>
            <p className="font-mono text-sm text-muted-foreground">{server.slug} · {server.apiEndpoint}</p>
          </div>
        </div>
        <Badge variant={server.status === 'online' ? 'success' : 'secondary'}>{serverStatusLabel(server.status)}</Badge>
      </div>

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
              {server.incusVersion || server.serverCertFingerprint
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
              {server.preflightStatus === PreflightStatus.Passed ? ' · 已通过' : ' · 选择探针池与地址后运行'}
            </li>
            <li>
              <Link to="/ip-pools" className="underline">去 IP 池绑定</Link>
            </li>
          </ol>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" />连接与互信</CardTitle>
            <CardDescription>trust token 只用于创建连接意图；服务端证书指纹用于身份校验。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="server-trust-token">Trust token</Label>
              <Input id="server-trust-token" value={trustToken} onChange={(event) => setTrustToken(event.target.value)} placeholder="粘贴 Incus trust token" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="server-cert-fingerprint">期望服务端证书指纹</Label>
              <Input id="server-cert-fingerprint" className="font-mono" value={expectedFingerprint || server.serverCertFingerprint || ''} onChange={(event) => setExpectedFingerprint(event.target.value)} placeholder="SHA256 fingerprint" />
            </div>
            <Button data-testid="server-connect" onClick={() => connect.mutate()} disabled={connect.isPending || !trustToken.trim() || !(expectedFingerprint || server.serverCertFingerprint)}>
              {connect.isPending ? '提交中...' : '连接服务器'}
            </Button>
            <InfoRow label="已观测指纹" value={server.serverCertFingerprint ?? '尚未观测'} mono />
            <InfoRow label="Incus 版本" value={server.incusVersion ?? '尚未连接'} />
            {server.lastError && <p className="break-all text-xs text-destructive">{server.lastError}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />前置检查</CardTitle>
            <CardDescription>检查网络转发、nftables、GPU toolkit、池与探针实例。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="preflight-pool">探针存储池</Label>
                <select id="preflight-pool" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={selectedPoolId} onChange={(event) => setSelectedPoolId(event.target.value)}>
                  <option value="">选择存储池</option>
                  {pools.filter((pool) => pool.registered).map((pool) => <option key={pool.id} value={pool.id}>{pool.displayName ?? pool.incusName}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="preflight-address">探针地址</Label>
                <Input id="preflight-address" value={probeAddress} onChange={(event) => setProbeAddress(event.target.value)} placeholder="10.20.0.10" />
              </div>
            </div>
            <Button data-testid="server-preflight" onClick={() => runPreflight.mutate()} disabled={runPreflight.isPending || !selectedPoolId || !probeAddress.trim()}>
              <Play className="h-4 w-4" />{runPreflight.isPending ? '检查中...' : '运行前置检查'}
            </Button>
            <PreflightReportView status={preflight?.status ?? server.preflightStatus} report={preflight?.report ?? server.preflightReport} />
          </CardContent>
        </Card>
      </div>

      <Card data-testid="server-node-metrics">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4" />node-exporter 指标</CardTitle>
              <CardDescription>使用固定 HTTPS /metrics endpoint、证书 pin 和 bearer token；token 只写入服务端，永不回显。</CardDescription>
            </div>
            <NodeMetricsHealthView health={server.nodeMetrics.health} />
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="node-metrics-endpoint">指标 endpoint</Label>
              <Input
                id="node-metrics-endpoint"
                value={nodeMetricsEndpoint}
                placeholder="https://node.example:9100/metrics"
                className="font-mono"
                onChange={(event) => setNodeMetricsEndpoint(event.target.value)}
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="node-metrics-cert-fingerprint">证书 pin（SHA-256）</Label>
              <Input
                id="node-metrics-cert-fingerprint"
                value={nodeMetricsCertFingerprint}
                placeholder="64 位十六进制指纹"
                className="font-mono"
                onChange={(event) => setNodeMetricsCertFingerprint(event.target.value)}
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="node-metrics-token">Bearer token</Label>
              <Input
                id="node-metrics-token"
                type="password"
                autoComplete="new-password"
                value={nodeMetricsToken}
                placeholder={server.nodeMetrics.tokenFingerprint ? '已配置；留空保持原 token' : '首次配置请输入 token'}
                onChange={(event) => setNodeMetricsToken(event.target.value)}
              />
              {server.nodeMetrics.tokenFingerprint && (
                <p className="break-all font-mono text-xs text-muted-foreground">
                  token fingerprint：{server.nodeMetrics.tokenFingerprint}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={saveNodeMetrics} disabled={updateServer.isPending}>
              {updateServer.isPending ? '保存中...' : '保存指标配置'}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  disabled={updateServer.isPending || server.nodeMetrics.health.status === NodeMetricsStatus.Unconfigured}
                >
                  清除指标配置
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>清除指标配置？</AlertDialogTitle>
                  <AlertDialogDescription>
                    将移除该服务器的 node-exporter 指标采集配置（endpoint、证书 pin 与 token）。确认后需重新填写才能恢复监控。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={clearNodeMetrics}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    确认清除
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="storage-pool-capabilities">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base"><HardDriveIcon />存储池能力</CardTitle>
              <CardDescription>前端只读取后端下发的能力，不根据驱动名称推断扩缩容行为。</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => discoverPools.mutate()} disabled={discoverPools.isPending}>
              <RefreshCw className={discoverPools.isPending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />发现存储池
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {fsidConflict && (
            <FsidConflictAlert conflict={fsidConflict} onDismiss={() => setFsidConflict(null)} />
          )}
          <div className="grid gap-3 rounded-md border bg-muted/20 p-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="server-system-pool">系统盘池</Label>
              <select id="server-system-pool" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={systemPoolId || currentSystemPool} onChange={(event) => setSystemPoolId(event.target.value)}>
                <option value="">未指定</option>
                {pools.filter((pool) => pool.registered && pool.rootDiskCapable).map((pool) => <option key={pool.id} value={pool.id}>{pool.displayName ?? pool.incusName}</option>)}
              </select>
              <p className="text-xs text-muted-foreground" data-testid="system-pool-new-containers-hint">
                更改系统盘池只影响之后新建的容器，不会改动已有容器。
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="server-overcommit">存储超分比例</Label>
              <Input id="server-overcommit" type="number" min="1" step="0.1" value={overcommitRatio || String(server.storageOvercommitRatio)} onChange={(event) => setOvercommitRatio(event.target.value)} />
            </div>
            <div className="flex items-end">
              <Button
                className="w-full"
                onClick={() => updateServer.mutate({
                  expectedRevision: server.revision,
                  systemPoolId: (systemPoolId || currentSystemPool) || null,
                  storageOvercommitRatio: Number(overcommitRatio || server.storageOvercommitRatio),
                })}
                disabled={updateServer.isPending}
              >
                保存服务器存储设置
              </Button>
            </div>
          </div>
          {poolsQuery.isError ? (
            <QueryErrorState error={poolsQuery.error} resourceName="存储池" onRetry={() => { void poolsQuery.refetch(); }} />
          ) : pools.length === 0 ? (
            <p className="text-sm text-muted-foreground">尚未发现存储池。</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr><th className="px-3 py-2">池</th><th className="px-3 py-2">容量</th><th className="px-3 py-2">能力</th><th className="px-3 py-2">登记</th><th className="px-3 py-2">操作</th></tr>
                </thead>
                <tbody>
                  {pools.map((pool) => (
                    <StoragePoolRow
                      key={pool.id}
                      pool={pool}
                      canManageStoragePools={canManageStoragePools}
                      onUpdated={invalidateServer}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {selectedPool && <p className="text-xs text-muted-foreground">探针池：{selectedPool.displayName ?? selectedPool.incusName}</p>}
          {!canManageStoragePools && (
            <p className="text-xs text-muted-foreground" data-testid="storage-pool-register-gated">
              可以查看存储池，但登记与取消登记需要「管理存储池」权限。
            </p>
          )}
        </CardContent>
      </Card>

      <Card data-testid="certificate-rotation">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base"><RotateCw className="h-4 w-4" />Incus 客户端证书</CardTitle>
              <CardDescription>轮换会生成收敛意图，各服务器 trust 状态在此处可见。</CardDescription>
            </div>
            {canManageCertificates ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" disabled={rotateCertificate.isPending || !certificate}>
                    <RotateCw className={rotateCertificate.isPending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />轮换证书
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>轮换 Incus 客户端证书？</AlertDialogTitle>
                    <AlertDialogDescription>
                      轮换会生成新的客户端证书收敛意图，各服务器需重新完成信任校验。期间可能短暂影响与 Incus 的互信。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => rotateCertificate.mutate()}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      确认轮换
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              <Button variant="outline" disabled>
                <RotateCw className="h-4 w-4" />轮换证书
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!canViewCertificate ? (
            <p className="text-sm text-muted-foreground" data-testid="certificate-rotate-gated">
              可以查看服务器，但查看客户端证书需要「管理服务器」或「管理证书」权限。
            </p>
          ) : !canManageCertificates && certificate ? (
            <>
              <p className="text-xs text-muted-foreground" data-testid="certificate-rotate-gated">
                可以查看证书状态，但轮换需要「管理证书」权限。
              </p>
              {certificateQuery.isLoading ? <QueryLoadingState label="加载证书..." /> : certificateQuery.isError ? (
                <QueryErrorState error={certificateQuery.error} resourceName="Incus 客户端证书" onRetry={() => { void certificateQuery.refetch(); }} />
              ) : (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <InfoRow label="代次" value={String(certificate.generation)} />
                    <InfoRow label="指纹" value={certificate.fingerprint} mono />
                    <InfoRow label="状态" value={certificate.state} />
                    <InfoRow label="生效时间" value={new Date(certificate.notBefore).toLocaleString()} />
                    <InfoRow label="过期时间" value={new Date(certificate.notAfter).toLocaleString()} />
                    <InfoRow
                      label="剩余有效期"
                      value={formatCertRemainingLabel(certificate.notAfter)}
                    />
                  </div>
                  {certExpiryWarning(certificate.notAfter) && (
                    <p className="text-sm text-destructive">
                      {certExpiryWarning(certificate.notAfter) === 'expired'
                        ? `客户端证书已于 ${new Date(certificate.notAfter).toLocaleDateString()} 过期，请轮换`
                        : `客户端证书将于 ${new Date(certificate.notAfter).toLocaleDateString()} 过期，请轮换`}
                    </p>
                  )}
                  <div className="grid gap-2 sm:grid-cols-2">
                    {certificate.servers.map((trust) => (
                      <CertificateTrustWizard
                        key={trust.serverId}
                        currentServerId={id}
                        trust={trust}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : certificateQuery.isLoading ? <QueryLoadingState label="加载证书..." /> : certificateQuery.isError ? (
            <QueryErrorState error={certificateQuery.error} resourceName="Incus 客户端证书" onRetry={() => { void certificateQuery.refetch(); }} />
          ) : certificate ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <InfoRow label="代次" value={String(certificate.generation)} />
                <InfoRow label="指纹" value={certificate.fingerprint} mono />
                <InfoRow label="状态" value={certificate.state} />
                <InfoRow label="生效时间" value={new Date(certificate.notBefore).toLocaleString()} />
                <InfoRow label="过期时间" value={new Date(certificate.notAfter).toLocaleString()} />
                <InfoRow
                  label="剩余有效期"
                  value={formatCertRemainingLabel(certificate.notAfter)}
                />
              </div>
              {certExpiryWarning(certificate.notAfter) && (
                <p className="text-sm text-destructive">
                  {certExpiryWarning(certificate.notAfter) === 'expired'
                    ? `客户端证书已于 ${new Date(certificate.notAfter).toLocaleDateString()} 过期，请轮换`
                    : `客户端证书将于 ${new Date(certificate.notAfter).toLocaleDateString()} 过期，请轮换`}
                </p>
              )}
              <ResourceIntentFailures
                listPath="/admin/intents?kind=certificate.rotate"
                admin
              />
              <div className="grid gap-2 sm:grid-cols-2">
                {certificate.servers.map((trust) => (
                  <CertificateTrustWizard
                    key={trust.serverId}
                    currentServerId={id}
                    trust={trust}
                  />
                ))}
              </div>
            </div>
          ) : <p className="text-sm text-muted-foreground">暂无客户端证书。</p>}
        </CardContent>
      </Card>
      <ResourceIntentFailures listPath={`/admin/servers/${id}/intents`} admin />
    </div>
  );
}

function StoragePoolRow({
  pool,
  canManageStoragePools,
  onUpdated,
}: {
  pool: StoragePoolDto;
  canManageStoragePools: boolean;
  onUpdated: () => void;
}) {
  const [confirmUnregister, setConfirmUnregister] = useState(false);
  const patch = useMutation({
    mutationFn: (registered: boolean) => api.patch<StoragePoolDto>(`/admin/storage-pools/${pool.id}`, {
      expectedRevision: pool.revision,
      registered,
      displayName: pool.displayName,
      sharedBackendId: pool.sharedBackendId,
    }),
    onSuccess: () => {
      setConfirmUnregister(false);
      onUpdated();
    },
    onError: (error) => toast({ title: '存储池更新失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const capability = pool.capability;
  return (
    <tr className="border-t">
      <td className="px-3 py-2"><div className="font-medium">{pool.displayName ?? pool.incusName}</div><div className="font-mono text-xs text-muted-foreground">{pool.driver} · {pool.resizeFamily}</div></td>
      <td className="px-3 py-2">{usedTotalLabel(pool.usedBytes, pool.totalBytes)}<div className="text-xs text-muted-foreground">{pool.quotaEffective === null ? '配额未知' : pool.quotaEffective ? '配额生效' : '配额未生效'}</div></td>
      <td className="px-3 py-2"><div className="flex flex-wrap gap-1"><Badge variant={capability.growOnline ? 'success' : 'secondary'}>在线扩容</Badge><Badge variant={capability.shrinkOnline ? 'success' : capability.shrinkNever ? 'destructive' : 'warning'}>{capability.shrinkOnline ? '在线缩容' : capability.shrinkNever ? '不可缩容' : '需停机/卸载'}</Badge>{pool.rootDiskCapable && <Badge variant="outline">系统盘</Badge>}{pool.shareable && <Badge variant="outline">共享</Badge>}</div></td>
      <td className="px-3 py-2">{pool.registered ? '已登记' : '未登记'}</td>
      <td className="px-3 py-2">
        <Button
          size="sm"
          variant={pool.registered ? 'outline' : 'default'}
          onClick={() => { if (pool.registered) setConfirmUnregister(true); else patch.mutate(true); }}
          disabled={patch.isPending || !canManageStoragePools}
        >
          {patch.isPending ? '保存中...' : pool.registered ? '取消登记' : '登记'}
        </Button>
        <Dialog open={confirmUnregister} onOpenChange={(open) => { if (!open) setConfirmUnregister(false); }}>
          <DialogContent data-testid="storage-pool-unregister-confirm">
            <DialogHeader>
              <DialogTitle>取消登记存储池？</DialogTitle>
              <DialogDescription>
                取消后，「{pool.displayName ?? pool.incusName}」将从可建卷集合中移除；已有数据卷不受影响，但新建卷时将无法再选择该池。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmUnregister(false)} disabled={patch.isPending}>取消</Button>
              <Button variant="destructive" onClick={() => patch.mutate(false)} disabled={patch.isPending}>
                {patch.isPending ? '处理中...' : '确认取消登记'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </td>
    </tr>
  );
}

function NodeMetricsHealthView({ health }: { health: ServerDto['nodeMetrics']['health'] }) {
  const statusLabel = nodeMetricsStatusLabel(health.status);
  return (
    <div className="space-y-1 text-right">
      <Badge variant={health.status === NodeMetricsStatus.Online ? 'success' : health.status === NodeMetricsStatus.Unreachable ? 'destructive' : 'secondary'}>
        {statusLabel}
      </Badge>
      {health.outageSince ? (
        <p className="text-xs text-destructive">数据中断自 {new Date(health.outageSince).toLocaleString()}</p>
      ) : health.status === NodeMetricsStatus.Unknown ? (
        <p className="text-xs text-muted-foreground">暂无成功样本</p>
      ) : null}
      {health.lastSuccessAt && (
        <p className="text-xs text-muted-foreground">最近成功 {relativeTime(health.lastSuccessAt)}</p>
      )}
      {health.lastError && <p className="max-w-[24rem] break-all text-xs text-destructive">{health.lastError}</p>}
    </div>
  );
}

function nodeMetricsStatusLabel(status: NodeMetricsStatus): string {
  return nodeMetricsStatusZh(status);
}

function PreflightReportView({ status, report }: { status: PreflightStatus; report: PreflightReport | null }) {
  if (!report) {
    return (
      <p className="text-sm text-muted-foreground">
        尚未运行前置检查（当前状态：{preflightStatusLabel(status)}）。
      </p>
    );
  }
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">检查状态：{preflightStatusLabel(status)}</span>
        <Badge variant={report.controlReady ? 'success' : 'destructive'}>
          {report.controlReady ? '控制面就绪' : '未就绪'}
        </Badge>
      </div>
      <div className="grid gap-1 sm:grid-cols-2">
        {Object.entries(report.checks).map(([name, result]) => (
          <div key={name} className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">{preflightCheckLabel(name)}</span>
            <span className={result === 'pass' ? 'text-green-600' : result === 'warn' ? 'text-amber-600' : 'text-destructive'}>
              {preflightResultLabel(result)}
            </span>
          </div>
        ))}
      </div>
      {report.failureCode && <p className="text-xs text-destructive">{report.failureCode}</p>}
    </div>
  );
}

function CertificateTrustWizard({
  currentServerId,
  trust,
}: {
  currentServerId: string;
  trust: IncusClientCertificateDto['servers'][number];
}) {
  const steps = [
    { key: 'trust', label: '信任新证书' },
    { key: 'switch', label: '切换' },
    { key: 'revoke', label: '撤销旧证书' },
  ] as const;
  const completed = trustWizardCompletedSteps(trust.trustState);
  const failedRevoke = trust.trustState === CertificateTrustState.CleanupFailed;
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm" data-testid="certificate-trust-wizard">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs">{trust.serverId}</p>
          <p className="text-xs text-muted-foreground">{trust.lastError ?? relativeTime(trust.observedAt)}</p>
        </div>
        <Badge variant={
          trust.serverId === currentServerId && trust.trustState === CertificateTrustState.Verified
            ? 'success'
            : trust.trustState === CertificateTrustState.Revoked
              ? 'success'
              : trust.trustState === CertificateTrustState.CleanupFailed
                ? 'destructive'
                : 'secondary'
        }>
          {certTrustStateLabel(trust.trustState)}
        </Badge>
      </div>
      <ol className="flex flex-wrap gap-1 text-[11px]">
        {steps.map((step, index) => {
          const done = completed > index;
          const current = completed === index;
          const revokeFailed = step.key === 'revoke' && failedRevoke;
          return (
            <li
              key={step.key}
              className={
                revokeFailed
                  ? 'rounded bg-destructive/10 px-2 py-1 text-destructive'
                  : done
                    ? 'rounded bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-300'
                    : current
                      ? 'rounded bg-amber-500/10 px-2 py-1'
                      : 'rounded bg-muted px-2 py-1 text-muted-foreground'
              }
            >
              {index + 1}. {step.label}
              {done ? ' ✓' : revokeFailed ? ' 失败' : current ? ' …' : ''}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function trustWizardCompletedSteps(state: CertificateTrustState): number {
  switch (state) {
    case CertificateTrustState.Trusted:
      return 1;
    case CertificateTrustState.Verified:
      return 2;
    case CertificateTrustState.Revoked:
      return 3;
    case CertificateTrustState.CleanupFailed:
      return 2;
    default:
      return 0;
  }
}

function certTrustStateLabel(state: CertificateTrustState): string {
  switch (state) {
    case CertificateTrustState.Pending:
      return '待信任';
    case CertificateTrustState.Trusted:
      return '已信任新证书';
    case CertificateTrustState.Verified:
      return '已切换';
    case CertificateTrustState.Revoked:
      return '已撤销旧证书';
    case CertificateTrustState.CleanupFailed:
      return '撤销旧证书失败';
    default:
      return state;
  }
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><p className={mono ? 'break-all font-mono text-xs' : 'break-all text-sm'}>{value}</p></div>;
}

function HardDriveIcon() {
  return <Server className="h-4 w-4" />;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请稍后重试';
}
