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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { Switch } from '../components/ui/switch.js';
import { Textarea } from '../components/ui/textarea.js';
import { FormField } from '../components/layout/form-field.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { TechnicalId } from '../components/refs/technical-id.js';
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
  const statusDescription = !canViewStatus
    ? undefined
    : statusQuery.isError
      ? '代理状态加载失败'
      : status.updatedAt ? `最后更新 ${formatTime(status.updatedAt)}` : '等待代理上报实时状态';

  return (
    <Page testId="http-proxy-ops">
      <PageHeader
        title="HTTP 代理"
        description={statusDescription}
        actions={canViewStatus ? (
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => { void statusQuery.refetch(); }} disabled={statusQuery.isFetching}>
            <RefreshCw className={`h-4 w-4 ${statusQuery.isFetching ? 'animate-spin' : ''}`} />
          </Button>
        ) : undefined}
      />

      {canViewStatus && (
        <QueryView query={statusQuery} resourceName="HTTP 代理状态" loadingLabel="加载 HTTP 代理状态...">
          {(loaded) => <HttpStatusSections status={loaded} />}
        </QueryView>
      )}

      {canManagePools && (
        <QueryView
          queries={[poolsQuery, bindingsQuery]}
          resourceNames={['域名池', 'HTTP 发布绑定']}
          loadingLabel="加载域名池..."
        >
          {() => (
            <div className="space-y-6">
              <SectionCard
                title="域名池"
                actions={
                  <>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => { void poolsQuery.refetch(); }} disabled={poolsQuery.isFetching}>
                      <RefreshCw className={`h-4 w-4 ${poolsQuery.isFetching ? 'animate-spin' : ''}`} />
                    </Button>
                    <Button size="sm" onClick={() => setPoolForm('create')}><Plus className="h-4 w-4" />新建域名池</Button>
                  </>
                }
                flush={pools.length > 0}
              >
                {pools.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    暂无域名池。登记通配域名后，用户才能把容器端口发布到匹配的主机名。
                  </p>
                ) : (
                  <Table className="min-w-[640px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>通配域名</TableHead>
                        <TableHead>启用</TableHead>
                        <TableHead>HTTPS</TableHead>
                        <TableHead>证书</TableHead>
                        <TableHead className="text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pools.map((pool) => (
                        <TableRow key={pool.id}>
                          <TableCell className="font-mono text-xs">{pool.wildcardDomain}</TableCell>
                          <TableCell>{pool.enabled ? '是' : '否'}</TableCell>
                          <TableCell>{pool.httpsEnabled ? '是' : '否'}</TableCell>
                          <TableCell>
                            {pool.certificateFingerprint ? (
                              <TechnicalId label="证书指纹" value={pool.certificateFingerprint} kind="opaque" />
                            ) : (
                              <span className="text-sm">未配置</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-2">
                              <Button size="sm" variant="outline" onClick={() => setPoolForm(pool)}>
                                <Pencil className="h-3.5 w-3.5" />编辑
                              </Button>
                              <Button size="sm" variant="destructive" onClick={() => setDeletePool(pool)}>
                                <Trash2 className="h-3.5 w-3.5" />删除
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </SectionCard>
              {Array.isArray(allBindings) ? (
                <SectionCard title="全部发布绑定" flush={allBindings.length > 0}>
                  {allBindings.length === 0 ? (
                    <p className="text-sm text-muted-foreground">暂无用户发布绑定。</p>
                  ) : (
                    <Table className="min-w-[720px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead>所有者</TableHead>
                          <TableHead>主机名</TableHead>
                          <TableHead>容器</TableHead>
                          <TableHead>端口</TableHead>
                          <TableHead>HTTPS</TableHead>
                          <TableHead>状态</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {allBindings.map((binding) => (
                          <TableRow key={binding.id}>
                            <TableCell>{binding.ownerUsername}</TableCell>
                            <TableCell className="font-mono text-xs">{binding.hostname}</TableCell>
                            <TableCell>{binding.containerName ?? binding.containerId}</TableCell>
                            <TableCell>{binding.targetPort}</TableCell>
                            <TableCell>{binding.entryHttpsEnabled ? '是' : '否'}</TableCell>
                            <TableCell>
                              <Badge variant={binding.status === 'ready' ? 'success' : binding.status === 'warning' ? 'warning' : 'secondary'}>
                                {httpProxyBindingStatusLabel(binding.status)}
                              </Badge>
                              {binding.warningReasons.length > 0 && (
                                <p className="mt-1 text-xs text-destructive">{httpProxyWarningLabel(binding.warningReasons)}</p>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </SectionCard>
              ) : null}
            </div>
          )}
        </QueryView>
      )}

      {poolForm && (
        <DomainPoolFormDialog
          pool={poolForm === 'create' ? undefined : poolForm}
          open
          onOpenChange={(open) => { if (!open) setPoolForm(null); }}
        />
      )}
      <ConfirmDialog
        open={Boolean(deletePool)}
        onOpenChange={(open) => { if (!open) setDeletePool(null); }}
        title="删除域名池？"
        description={`将删除通配域名「${deletePool?.wildcardDomain}」。若仍有 HTTP 发布使用该池，删除会被拒绝。请先停用该池，或让用户删除相关发布。`}
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={removePool.isPending}
        onConfirm={() => { if (deletePool) removePool.mutate(deletePool.id); }}
      />
    </Page>
  );
}

function HttpStatusSections({ status }: { status: HttpProxyAdminStatus }) {
  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricTile icon={Wifi} label="在线代理" value={status.connectedProxies.toString()} sub={`${(status.proxies ?? []).length} 个实例上报`} />
        <MetricTile icon={Activity} label="活跃连接" value={status.activeConnections.toString()} sub={`累计请求 ${status.totalRequests}`} />
        <MetricTile icon={Globe} label="累计请求" value={status.totalRequests.toString()} sub={`拒绝 ${status.totalRejectedRequests}`} />
        <MetricTile icon={Activity} label="拒绝请求" value={status.totalRejectedRequests.toString()} sub="累计拒绝" />
      </section>
      <SectionCard
        title="代理实例"
        actions={
          <Badge variant={status.connectedProxies > 0 ? 'success' : 'outline'}>
            {status.connectedProxies > 0 ? '在线' : '离线'}
          </Badge>
        }
        flush
      >
          <Table className="min-w-[640px]">
            <TableHeader>
              <TableRow>
                <TableHead>代理</TableHead>
                <TableHead>HTTP</TableHead>
                <TableHead>HTTPS</TableHead>
                <TableHead>连接</TableHead>
                <TableHead>请求</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(status.proxies ?? []).length === 0 ? (
                <TableRow>
                  <TableCell className="py-8 text-center text-muted-foreground" colSpan={5}>暂无在线 HTTP 代理</TableCell>
                </TableRow>
              ) : (status.proxies ?? []).map((proxy) => (
                <TableRow key={proxy.proxyId}>
                  <TableCell>
                    {proxy.hostname ? (
                      <div className="font-medium text-foreground">{proxy.hostname}</div>
                    ) : null}
                    <TechnicalId label="代理" value={proxy.proxyId} kind="opaque" />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{formatListen(proxy.httpListen)}</TableCell>
                  <TableCell className="font-mono text-xs">{formatListen(proxy.httpsListen)}</TableCell>
                  <TableCell>{proxy.activeConnections}</TableCell>
                  <TableCell className="whitespace-nowrap">{proxy.totalRequests} / 拒绝 {proxy.totalRejectedRequests}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
      </SectionCard>
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
      <DialogContent data-testid="http-domain-pool-form">
        <DialogHeader>
          <DialogTitle>{pool ? '编辑域名池' : '新建域名池'}</DialogTitle>
          <DialogDescription>
            通配域名形如 *.example.com。HTTPS 开启后再填写证书。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <FormField id="http-pool-wildcard" label="通配域名">
            <Input
              id="http-pool-wildcard"
              className="font-mono"
              value={wildcardDomain}
              placeholder="*.example.com"
              onChange={(event) => { setWildcardDomain(event.target.value); setError(null); }}
            />
          </FormField>
          <FormField id="http-pool-enabled" label="启用" orientation="inline">
            <Switch id="http-pool-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </FormField>
          <FormField id="http-pool-https" label="启用 HTTPS" orientation="inline">
            <Switch id="http-pool-https" checked={httpsEnabled} onCheckedChange={setHttpsEnabled} />
          </FormField>
          {httpsPemIncomplete && (
            <p className="text-xs text-destructive">启用 HTTPS 时请同时提供证书和私钥 PEM。</p>
          )}
          {pool?.certificateFingerprint ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>当前证书指纹：</span>
              <TechnicalId label="证书指纹" value={pool.certificateFingerprint} kind="opaque" />
            </div>
          ) : null}
          {httpsEnabled && (
            <>
              <FormField id="http-pool-cert" label="证书 PEM">
                <Textarea
                  id="http-pool-cert"
                  className="max-h-32 min-h-24 overflow-y-auto font-mono text-xs"
                  value={certificatePem}
                  placeholder={pool ? '留空则保留现有证书' : '-----BEGIN CERTIFICATE-----'}
                  onChange={(event) => { setCertificatePem(event.target.value); setError(null); }}
                />
              </FormField>
              <FormField id="http-pool-key" label="私钥 PEM">
                <Textarea
                  id="http-pool-key"
                  className="max-h-32 min-h-24 overflow-y-auto font-mono text-xs"
                  value={privateKeyPem}
                  placeholder={pool ? '留空则保留现有私钥' : '-----BEGIN PRIVATE KEY-----'}
                  onChange={(event) => { setPrivateKeyPem(event.target.value); setError(null); }}
                />
              </FormField>
            </>
          )}
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

function formatListen(value: string | null | undefined): string {
  if (!value) return '—';
  return value.startsWith(':') ? `0.0.0.0${value}` : value;
}

function formatTime(value: string | number): string {
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}
