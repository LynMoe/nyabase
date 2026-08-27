import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ComponentType } from 'react';
import { Activity, Globe, Pencil, Plus, RefreshCw, Trash2, Wifi } from 'lucide-react';
import {
  zCreateHttpDomainPoolRequest,
  zPatchHttpDomainPoolRequest,
  type CreateHttpDomainPoolRequest,
  type HttpDomainPoolDto,
  type HttpProxyBindingDto,
  type HttpProxyStatusReport,
  type PatchHttpDomainPoolRequest,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { ApiError } from '../lib/api-error.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
import { toast } from '../hooks/use-toast.js';
import { useAuthStore } from '../store/auth.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import {
  canManageHttpProxyPools,
  canViewHttpProxyStatus,
} from '../lib/http-proxy-access.js';
import {
  emptyIfNotFound,
  httpProxyBindingStatusLabel,
  httpProxyErrorMessage,
  httpProxyWarningLabel,
} from '../lib/http-proxy.js';

interface HttpProxyAdminStatus {
  connectedProxies: number;
  activeConnections: number;
  totalRequests: number;
  totalRejectedRequests: number;
  updatedAt: string | null;
  proxies: HttpProxyStatusReport[];
}

const emptyStatus: HttpProxyAdminStatus = {
  connectedProxies: 0,
  activeConnections: 0,
  totalRequests: 0,
  totalRejectedRequests: 0,
  updatedAt: null,
  proxies: [],
};

export default function HttpProxyOpsPage() {
  const qc = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const canViewStatus = canViewHttpProxyStatus(user?.capabilities ?? []);
  const canManagePools = canManageHttpProxyPools(user?.capabilities ?? []);
  const [poolForm, setPoolForm] = useState<HttpDomainPoolDto | 'create' | null>(null);
  const [deletePool, setDeletePool] = useState<HttpDomainPoolDto | null>(null);

  const statusQuery = useQuery({
    queryKey: queryKeys.httpProxy.adminStatus,
    queryFn: () => api.get<HttpProxyAdminStatus>('/admin/http-proxy/status'),
    refetchInterval: (query) => queryPollInterval(query.state, {
      activeIntervalMs: 1_000,
      transientBaseIntervalMs: 2_000,
      transientMaxIntervalMs: 30_000,
    }),
    enabled: canViewStatus,
  });
  const poolsQuery = useQuery({
    queryKey: queryKeys.httpProxy.adminDomainPools,
    queryFn: () => api.get<HttpDomainPoolDto[]>('/admin/http-proxy/domain-pools'),
    enabled: canManagePools,
  });
  const bindingsQuery = useQuery({
    queryKey: queryKeys.httpProxy.adminBindings,
    queryFn: () => api.get<HttpProxyBindingDto[]>('/admin/http-proxy/bindings')
      .catch(emptyIfNotFound<HttpProxyBindingDto[] | null>(null)),
    enabled: canManagePools,
    retry: (count, error) => (error instanceof ApiError && error.status === 404 ? false : count < 2),
  });

  const removePool = useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`/admin/http-proxy/domain-pools/${id}`),
    onSuccess: () => {
      toast({ title: '域名池已删除' });
      setDeletePool(null);
      void qc.invalidateQueries({ queryKey: queryKeys.httpProxy.adminDomainPools });
    },
    onError: (error) => toast({ title: '删除失败', description: httpProxyErrorMessage(error), variant: 'destructive' }),
  });
  const status = statusQuery.data ?? emptyStatus;
  const pools = poolsQuery.data ?? [];
  const allBindings = bindingsQuery.data;

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full" data-testid="http-proxy-ops">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">HTTP 代理</h1>
          {canViewStatus && (
            <p className="text-sm text-muted-foreground mt-0.5">
              {statusQuery.isError
                ? '代理状态加载失败'
                : status.updatedAt ? `最后更新 ${formatTime(status.updatedAt)}` : '等待代理上报实时状态'}
            </p>
          )}
        </div>
        {canViewStatus && (
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => { void statusQuery.refetch(); }} disabled={statusQuery.isFetching}>
            <RefreshCw className={`h-4 w-4 ${statusQuery.isFetching ? 'animate-spin' : ''}`} />
          </Button>
        )}
      </div>

      {canViewStatus && statusQuery.isLoading && <QueryLoadingState label="加载 HTTP 代理状态..." />}
      {canViewStatus && statusQuery.isError && (
        <QueryErrorState error={statusQuery.error} resourceName="HTTP 代理状态" onRetry={() => { void statusQuery.refetch(); }} />
      )}
      {canViewStatus && statusQuery.isSuccess && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricTile icon={Wifi} label="在线代理" value={status.connectedProxies.toString()} sub={`${status.proxies.length} 个实例上报`} />
            <MetricTile icon={Activity} label="活跃连接" value={status.activeConnections.toString()} sub={`累计请求 ${status.totalRequests}`} />
            <MetricTile icon={Globe} label="累计请求" value={status.totalRequests.toString()} sub={`拒绝 ${status.totalRejectedRequests}`} />
            <MetricTile icon={Activity} label="拒绝请求" value={status.totalRejectedRequests.toString()} sub="累计" />
          </section>
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-base font-semibold text-foreground">代理实例</h2>
              <Badge variant={status.connectedProxies > 0 ? 'success' : 'outline'}>
                {status.connectedProxies > 0 ? '在线' : '离线'}
              </Badge>
            </div>
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">代理</th>
                    <th className="text-left font-medium px-3 py-2">HTTP</th>
                    <th className="text-left font-medium px-3 py-2">HTTPS</th>
                    <th className="text-left font-medium px-3 py-2">连接</th>
                    <th className="text-left font-medium px-3 py-2">请求</th>
                  </tr>
                </thead>
                <tbody>
                  {status.proxies.length === 0 ? (
                    <tr>
                      <td className="px-3 py-8 text-center text-muted-foreground" colSpan={5}>暂无在线 HTTP 代理</td>
                    </tr>
                  ) : status.proxies.map((proxy) => (
                    <tr key={proxy.proxyId} className="border-t border-border">
                      <td className="px-3 py-2">
                        <div className="font-medium text-foreground">{proxy.hostname ?? proxy.proxyId}</div>
                        <div className="font-mono text-xs text-muted-foreground break-all">{proxy.proxyId}</div>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{proxy.httpListen}</td>
                      <td className="px-3 py-2 font-mono text-xs">{proxy.httpsListen ?? '-'}</td>
                      <td className="px-3 py-2">{proxy.activeConnections}</td>
                      <td className="px-3 py-2">{proxy.totalRequests} / 拒绝 {proxy.totalRejectedRequests}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {canManagePools && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-foreground">域名池</h2>
            <div className="flex gap-2">
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => { void poolsQuery.refetch(); }} disabled={poolsQuery.isFetching}>
                <RefreshCw className={`h-4 w-4 ${poolsQuery.isFetching ? 'animate-spin' : ''}`} />
              </Button>
              <Button size="sm" onClick={() => setPoolForm('create')}><Plus className="h-4 w-4" />新建域名池</Button>
            </div>
          </div>
          {poolsQuery.isLoading ? (
            <QueryLoadingState label="加载域名池..." />
          ) : poolsQuery.isError ? (
            <QueryErrorState error={poolsQuery.error} resourceName="域名池" onRetry={() => { void poolsQuery.refetch(); }} />
          ) : pools.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                暂无域名池。登记通配域名后，用户才能把容器端口发布到匹配的主机名。
              </CardContent>
            </Card>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">通配域名</th>
                    <th className="text-left font-medium px-3 py-2">启用</th>
                    <th className="text-left font-medium px-3 py-2">HTTPS</th>
                    <th className="text-left font-medium px-3 py-2">证书</th>
                    <th className="text-right font-medium px-3 py-2">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {pools.map((pool) => (
                    <tr key={pool.id} className="border-t border-border">
                      <td className="px-3 py-2 font-mono text-xs">{pool.wildcardDomain}</td>
                      <td className="px-3 py-2">{pool.enabled ? '是' : '否'}</td>
                      <td className="px-3 py-2">{pool.httpsEnabled ? '是' : '否'}</td>
                      <td className="px-3 py-2 font-mono text-xs break-all">{pool.certificateFingerprint ?? '未配置'}</td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="outline" onClick={() => setPoolForm(pool)}>
                            <Pencil className="h-3.5 w-3.5" />编辑
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => setDeletePool(pool)}>
                            <Trash2 className="h-3.5 w-3.5" />删除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {canManagePools && bindingsQuery.isError && !(bindingsQuery.error instanceof ApiError && bindingsQuery.error.status === 404) && (
        <QueryErrorState error={bindingsQuery.error} resourceName="HTTP 发布绑定" onRetry={() => { void bindingsQuery.refetch(); }} />
      )}
      {canManagePools && Array.isArray(allBindings) && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-foreground">全部发布绑定</h2>
          {allBindings.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无用户发布绑定。</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">所有者</th>
                    <th className="text-left font-medium px-3 py-2">主机名</th>
                    <th className="text-left font-medium px-3 py-2">容器</th>
                    <th className="text-left font-medium px-3 py-2">端口</th>
                    <th className="text-left font-medium px-3 py-2">HTTPS</th>
                    <th className="text-left font-medium px-3 py-2">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {allBindings.map((binding) => (
                    <tr key={binding.id} className="border-t border-border">
                      <td className="px-3 py-2">{binding.ownerUsername}</td>
                      <td className="px-3 py-2 font-mono text-xs">{binding.hostname}</td>
                      <td className="px-3 py-2">{binding.containerName ?? binding.containerId}</td>
                      <td className="px-3 py-2">{binding.targetPort}</td>
                      <td className="px-3 py-2">{binding.entryHttpsEnabled ? '是' : '否'}</td>
                      <td className="px-3 py-2">
                        <Badge variant={binding.status === 'ready' ? 'success' : binding.status === 'warning' ? 'warning' : 'secondary'}>
                          {httpProxyBindingStatusLabel(binding.status)}
                        </Badge>
                        {binding.warningReasons.length > 0 && (
                          <p className="mt-1 text-xs text-destructive">{httpProxyWarningLabel(binding.warningReasons)}</p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {poolForm && (
        <DomainPoolFormDialog
          pool={poolForm === 'create' ? undefined : poolForm}
          open
          onOpenChange={(open) => { if (!open) setPoolForm(null); }}
        />
      )}
      <Dialog open={Boolean(deletePool)} onOpenChange={(open) => { if (!open) setDeletePool(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除域名池？</DialogTitle>
            <DialogDescription>
              将删除通配域名「{deletePool?.wildcardDomain}」。若仍有 HTTP 发布使用该池，删除会被拒绝。请先停用该池，或让用户删除相关发布。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletePool(null)}>取消</Button>
            <Button
              variant="destructive"
              disabled={removePool.isPending}
              onClick={() => { if (deletePool) removePool.mutate(deletePool.id); }}
            >
              {removePool.isPending ? '删除中...' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DomainPoolFormDialog({
  pool,
  open,
  onOpenChange,
}: {
  pool?: HttpDomainPoolDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [wildcardDomain, setWildcardDomain] = useState(pool?.wildcardDomain ?? '');
  const [enabled, setEnabled] = useState(pool?.enabled ?? true);
  const [httpsEnabled, setHttpsEnabled] = useState(pool?.httpsEnabled ?? false);
  const [certificatePem, setCertificatePem] = useState('');
  const [privateKeyPem, setPrivateKeyPem] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: CreateHttpDomainPoolRequest) => api.post<HttpDomainPoolDto>('/admin/http-proxy/domain-pools', body),
    onSuccess: () => {
      toast({ title: '域名池已创建' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.httpProxy.adminDomainPools });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(httpProxyErrorMessage(mutationError)),
  });
  const patch = useMutation({
    mutationFn: (body: PatchHttpDomainPoolRequest) => api.patch<HttpDomainPoolDto>(`/admin/http-proxy/domain-pools/${pool?.id ?? ''}`, body),
    onSuccess: () => {
      toast({ title: '域名池已更新' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.httpProxy.adminDomainPools });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(httpProxyErrorMessage(mutationError)),
  });
  const httpsNeedsPem = httpsEnabled && (!pool?.httpsEnabled || !pool.certificateFingerprint);
  const httpsPemIncomplete = httpsEnabled && (
    Boolean(certificatePem.trim()) !== Boolean(privateKeyPem.trim())
    || (httpsNeedsPem && (!certificatePem.trim() || !privateKeyPem.trim()))
  );
  const submit = () => {
    setError(null);
    if (!wildcardDomain.trim()) {
      setError('请输入通配域名');
      return;
    }
    if (httpsPemIncomplete) {
      setError('启用 HTTPS 时请同时提供证书和私钥 PEM');
      return;
    }
    if (!pool) {
      const parsed = zCreateHttpDomainPoolRequest.safeParse({
        wildcardDomain: wildcardDomain.trim(),
        enabled,
        httpsEnabled,
        certificatePem: certificatePem.trim() || null,
        privateKeyPem: privateKeyPem.trim() || null,
      });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? '请检查域名池参数');
        return;
      }
      create.mutate(parsed.data);
      return;
    }
    const body: PatchHttpDomainPoolRequest = {
      wildcardDomain: wildcardDomain.trim(),
      enabled,
      httpsEnabled,
    };
    if (certificatePem.trim()) body.certificatePem = certificatePem.trim();
    if (privateKeyPem.trim()) body.privateKeyPem = privateKeyPem.trim();
    const parsed = zPatchHttpDomainPoolRequest.safeParse(body);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查域名池参数');
      return;
    }
    patch.mutate(parsed.data);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto" data-testid="http-domain-pool-form">
        <DialogHeader>
          <DialogTitle>{pool ? '编辑域名池' : '新建域名池'}</DialogTitle>
          <DialogDescription>
            通配域名形如 *.example.com。启用 HTTPS 时需要提供证书与私钥 PEM。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="http-pool-wildcard">通配域名</Label>
            <Input
              id="http-pool-wildcard"
              className="font-mono"
              value={wildcardDomain}
              placeholder="*.example.com"
              onChange={(event) => { setWildcardDomain(event.target.value); setError(null); }}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            启用
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={httpsEnabled} onChange={(event) => setHttpsEnabled(event.target.checked)} />
            启用 HTTPS
          </label>
          {httpsPemIncomplete && (
            <p className="text-xs text-destructive">启用 HTTPS 时请同时提供证书和私钥 PEM。</p>
          )}
          {pool?.certificateFingerprint && (
            <p className="text-xs text-muted-foreground">当前证书指纹：{pool.certificateFingerprint}</p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="http-pool-cert">证书 PEM</Label>
            <textarea
              id="http-pool-cert"
              className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
              value={certificatePem}
              placeholder={pool ? '留空则保留现有证书' : '-----BEGIN CERTIFICATE-----'}
              onChange={(event) => { setCertificatePem(event.target.value); setError(null); }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="http-pool-key">私钥 PEM</Label>
            <textarea
              id="http-pool-key"
              className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
              value={privateKeyPem}
              placeholder={pool ? '留空则保留现有私钥' : '-----BEGIN PRIVATE KEY-----'}
              onChange={(event) => { setPrivateKeyPem(event.target.value); setError(null); }}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={create.isPending || patch.isPending || httpsPemIncomplete}>
            {create.isPending || patch.isPending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MetricTile({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{label}</p>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className="mt-2 text-xl font-semibold text-foreground break-words">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

function formatTime(value: string | number): string {
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

