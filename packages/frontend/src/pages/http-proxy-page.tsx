import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Edit, Globe2, Plus, RefreshCw, Save, Trash2, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Capability,
  normalizeHttpProxyHostname,
  normalizeHttpProxyWildcardDomain,
  type ContainerStatus,
  type HttpProxyBindingStatus,
  type HttpProxyWarningReason,
} from '@nyabase/common';
import { api, ApiError } from '../lib/api.js';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { toast } from '../hooks/use-toast.js';
import { useAuthStore } from '../store/auth.js';

interface Binding {
  id: string;
  mine: boolean;
  ownerId: string;
  ownerUsername: string;
  hostname: string;
  domainPoolId: string;
  domainPool: string;
  targetUrl: string | null;
  containerId: string;
  containerName: string | null;
  containerStatus: ContainerStatus | 'missing' | null;
  targetPort: number;
  entryHttpsEnabled: boolean;
  status: HttpProxyBindingStatus;
  warningReasons: HttpProxyWarningReason[];
  warningMessage: string;
}

interface DomainPool {
  id: string;
  wildcardDomain: string;
  enabled: boolean;
  httpsEnabled: boolean;
  certificateFingerprint: string | null;
  certificateNotAfter: string | null;
}

interface ContainerOption {
  id: string;
  name: string;
}

interface ProxyStatus {
  connectedProxies: number;
  totalRequests: number;
  totalRejectedRequests: number;
  updatedAt: string | null;
}

const emptyBindingForm = {
  hostname: '',
  containerId: '',
  targetPort: '80',
};

const emptyPoolForm = {
  wildcardDomain: '',
  enabled: true,
  httpsEnabled: false,
  certificatePem: '',
  privateKeyPem: '',
};

type BindingField = keyof typeof emptyBindingForm;
type BindingFormErrors = Partial<Record<BindingField, string>>;
type PoolField = keyof Pick<typeof emptyPoolForm, 'wildcardDomain' | 'certificatePem' | 'privateKeyPem'>;
type PoolFormErrors = Partial<Record<PoolField, string>>;

interface SaveBindingPayload {
  hostname: string;
  containerId: string;
  targetPort: number;
}

interface SavePoolPayload {
  wildcardDomain: string;
  enabled: boolean;
  httpsEnabled: boolean;
  certificatePem?: string | null;
  privateKeyPem?: string | null;
}

export default function HttpProxyPage() {
  const qc = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const canManageSettings = user?.capabilities.includes(Capability.ManageSystemSettings) ?? false;
  const canViewMetrics = user?.capabilities.includes(Capability.ViewMetricsAll) ?? false;
  const [bindingForm, setBindingForm] = useState(emptyBindingForm);
  const [bindingErrors, setBindingErrors] = useState<BindingFormErrors>({});
  const [editingBindingId, setEditingBindingId] = useState<string | null>(null);
  const [deletingBinding, setDeletingBinding] = useState<Binding | null>(null);
  const [poolForm, setPoolForm] = useState(emptyPoolForm);
  const [poolErrors, setPoolErrors] = useState<PoolFormErrors>({});
  const [editingPoolId, setEditingPoolId] = useState<string | null>(null);
  const [deletingPool, setDeletingPool] = useState<DomainPool | null>(null);

  const bindings = useQuery({
    queryKey: ['http-proxy-bindings'],
    queryFn: () => api.get<Binding[]>('/v2/http-proxy/bindings'),
    refetchInterval: 5_000,
  });
  const pools = useQuery({
    queryKey: ['http-proxy-domain-pools'],
    queryFn: () => api.get<DomainPool[]>('/admin/http-proxy/domain-pools'),
    enabled: canManageSettings,
  });
  const status = useQuery({
    queryKey: ['http-proxy-status'],
    queryFn: () => api.get<ProxyStatus>('/admin/http-proxy/status'),
    refetchInterval: 2_000,
    enabled: canViewMetrics,
  });
  const containers = useQuery({
    queryKey: ['containers-for-http-proxy'],
    queryFn: () => api.get<ContainerOption[]>('/v2/containers'),
  });

  const containerOptions = useMemo(() => (containers.data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
  })), [containers.data]);

  const saveBinding = useMutation({
    mutationFn: async (payload: SaveBindingPayload) => {
      return editingBindingId
        ? api.patch<Binding>(`/v2/http-proxy/bindings/${editingBindingId}`, payload)
        : api.post<Binding>('/v2/http-proxy/bindings', payload);
    },
    onSuccess: () => {
      setBindingForm(emptyBindingForm);
      setBindingErrors({});
      setEditingBindingId(null);
      qc.invalidateQueries({ queryKey: ['http-proxy-bindings'] });
      toast({ title: '域名绑定已保存' });
    },
    onError: (error) => toast({
      title: '保存失败',
      description: bindingErrorMessage(error),
      variant: 'destructive',
    }),
  });

  const deleteBinding = useMutation({
    mutationFn: (id: string) => api.delete(`/v2/http-proxy/bindings/${id}`),
    onSuccess: () => {
      setDeletingBinding(null);
      qc.invalidateQueries({ queryKey: ['http-proxy-bindings'] });
      toast({ title: '域名绑定已删除' });
    },
    onError: (error) => toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const savePool = useMutation({
    mutationFn: async (payload: SavePoolPayload) => {
      return editingPoolId
        ? api.patch<DomainPool>(`/admin/http-proxy/domain-pools/${editingPoolId}`, payload)
        : api.post<DomainPool>('/admin/http-proxy/domain-pools', payload);
    },
    onSuccess: () => {
      setPoolForm(emptyPoolForm);
      setPoolErrors({});
      setEditingPoolId(null);
      qc.invalidateQueries({ queryKey: ['http-proxy-domain-pools'] });
      qc.invalidateQueries({ queryKey: ['http-proxy-bindings'] });
      toast({ title: '域名池已保存' });
    },
    onError: (error) => toast({ title: '保存失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const deletePool = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/http-proxy/domain-pools/${id}`),
    onSuccess: () => {
      setDeletingPool(null);
      qc.invalidateQueries({ queryKey: ['http-proxy-domain-pools'] });
      qc.invalidateQueries({ queryKey: ['http-proxy-bindings'] });
      toast({ title: '域名池已删除' });
    },
    onError: (error) => toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const rows = bindings.data ?? [];
  const poolRows = pools.data ?? [];

  const setBindingField = (field: BindingField, value: string) => {
    setBindingForm((form) => ({ ...form, [field]: value }));
    setBindingErrors((errors) => withoutFieldError(errors, field));
  };

  const setPoolField = (field: keyof typeof emptyPoolForm, value: string | boolean) => {
    setPoolForm((form) => ({ ...form, [field]: value }));
    if (field === 'wildcardDomain' || field === 'certificatePem' || field === 'privateKeyPem') {
      setPoolErrors((errors) => withoutFieldError(errors, field));
    }
  };

  const handleSaveBinding = () => {
    const result = validateBindingForm(bindingForm, containerOptions);
    setBindingErrors(result.errors);
    if (!result.payload) {
      toast({
        title: '请检查绑定字段',
        description: firstError(result.errors),
        variant: 'destructive',
      });
      return;
    }
    saveBinding.mutate(result.payload);
  };

  const handleSavePool = () => {
    const result = validatePoolForm(poolForm, editingPoolId !== null);
    setPoolErrors(result.errors);
    if (!result.payload) {
      toast({
        title: '请检查域名池字段',
        description: firstError(result.errors),
        variant: 'destructive',
      });
      return;
    }
    savePool.mutate(result.payload);
  };

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">HTTP 反代</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {canViewMetrics && status.data?.updatedAt ? `最后更新 ${formatTime(status.data.updatedAt)}` : `${rows.length} 个域名绑定`}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" aria-label="刷新 HTTP 反代绑定" onClick={() => bindings.refetch()} disabled={bindings.isFetching}>
          <RefreshCw className={`h-4 w-4 ${bindings.isFetching ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {canViewMetrics && (
        <>
          {status.isError && (
            <QueryErrorNotice
              title="代理状态加载失败"
              error={status.error}
              onRetry={() => status.refetch()}
              isRetrying={status.isFetching}
            />
          )}
          <section className="grid gap-3 sm:grid-cols-3">
            <Metric label="在线代理" value={(status.data?.connectedProxies ?? 0).toString()} />
            <Metric label="累计请求" value={(status.data?.totalRequests ?? 0).toString()} />
            <Metric label="拒绝请求" value={(status.data?.totalRejectedRequests ?? 0).toString()} />
          </section>
        </>
      )}

      <section className="grid gap-4 xl:grid-cols-[360px_1fr]">
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-foreground">{editingBindingId ? '编辑绑定' : '新增绑定'}</h2>
            {editingBindingId && (
              <Button variant="ghost" size="sm" onClick={() => { setEditingBindingId(null); setBindingForm(emptyBindingForm); setBindingErrors({}); }}>
                <XCircle className="h-4 w-4" />
                取消
              </Button>
            )}
          </div>
          <FormField id="http-binding-hostname" label="域名" error={bindingErrors.hostname}>
            <Input
              id="http-binding-hostname"
              value={bindingForm.hostname}
              onChange={(event) => setBindingField('hostname', event.target.value)}
              placeholder="app.apps.example.com"
              aria-invalid={!!bindingErrors.hostname}
              aria-describedby={bindingErrors.hostname ? 'http-binding-hostname-error' : undefined}
              className={bindingErrors.hostname ? 'border-destructive focus-visible:ring-destructive' : undefined}
            />
          </FormField>
          <FormField id="http-binding-container" label="目标容器" error={bindingErrors.containerId}>
            <select
              id="http-binding-container"
              className={`h-9 w-full rounded-md border bg-background px-3 text-sm ${bindingErrors.containerId ? 'border-destructive' : 'border-input'}`}
              value={bindingForm.containerId}
              onChange={(event) => setBindingField('containerId', event.target.value)}
              aria-invalid={!!bindingErrors.containerId}
              aria-describedby={bindingErrors.containerId ? 'http-binding-container-error' : undefined}
            >
              <option value="">选择容器</option>
              {containerOptions.map((container) => <option key={container.id} value={container.id}>{container.name}</option>)}
            </select>
            {containers.isError && (
              <InlineErrorNotice
                title="容器列表加载失败"
                error={containers.error}
                onRetry={() => containers.refetch()}
                isRetrying={containers.isFetching}
              />
            )}
          </FormField>
          <FormField id="http-binding-port" label="HTTP 上游端口" error={bindingErrors.targetPort}>
            <Input
              id="http-binding-port"
              type="number"
              min={1}
              max={65535}
              value={bindingForm.targetPort}
              onChange={(event) => setBindingField('targetPort', event.target.value)}
              aria-invalid={!!bindingErrors.targetPort}
              aria-describedby={bindingErrors.targetPort ? 'http-binding-port-error' : undefined}
              className={bindingErrors.targetPort ? 'border-destructive focus-visible:ring-destructive' : undefined}
            />
          </FormField>
          <Button className="w-full" onClick={handleSaveBinding} disabled={saveBinding.isPending}>
            <Save className="h-4 w-4" />
            保存绑定
          </Button>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {bindings.isError ? (
            <div className="p-4">
              <QueryErrorNotice
                title="域名绑定加载失败"
                error={bindings.error}
                onRetry={() => bindings.refetch()}
                isRetrying={bindings.isFetching}
              />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-xs text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-3 py-2">域名</th>
                  <th className="text-left font-medium px-3 py-2">占用者</th>
                  <th className="text-left font-medium px-3 py-2">目标</th>
                  <th className="text-left font-medium px-3 py-2">协议</th>
                  <th className="text-left font-medium px-3 py-2">入口 HTTPS</th>
                  <th className="text-left font-medium px-3 py-2">状态</th>
                  <th className="text-right font-medium px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td className="px-3 py-8 text-center text-muted-foreground" colSpan={7}>暂无域名绑定</td></tr>
                ) : rows.map((binding) => (
                  <tr key={binding.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2 font-medium text-foreground">
                        <Globe2 className="h-4 w-4 text-muted-foreground" />
                        {binding.hostname}
                        {binding.status === 'warning' && <AlertTriangle className="h-4 w-4 text-amber-500" />}
                      </div>
                      <div className="text-xs text-muted-foreground">{binding.domainPool}</div>
                      {binding.warningMessage && <div className="text-xs text-amber-600 mt-1">{binding.warningMessage}</div>}
                    </td>
                    <td className="px-3 py-2">{binding.ownerUsername}</td>
                    <td className="px-3 py-2">
                      <div>{binding.containerName ?? binding.containerId}</div>
                      <div className="font-mono text-xs text-muted-foreground">{binding.targetUrl ?? '-'}</div>
                    </td>
                    <td className="px-3 py-2 uppercase">HTTP:{binding.targetPort}</td>
                    <td className="px-3 py-2">{binding.entryHttpsEnabled ? '开启' : '关闭'}</td>
                    <td className="px-3 py-2"><StatusBadge status={binding.status} /></td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`编辑绑定 ${binding.hostname}`} disabled={!binding.mine} onClick={() => {
                          setEditingBindingId(binding.id);
                          setBindingErrors({});
                          setBindingForm({
                            hostname: binding.hostname,
                            containerId: binding.containerId,
                            targetPort: String(binding.targetPort),
                          });
                        }}>
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label={`删除绑定 ${binding.hostname}`} disabled={!binding.mine || deleteBinding.isPending} onClick={() => setDeletingBinding(binding)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {canManageSettings && (
        <section className="grid gap-4 xl:grid-cols-[360px_1fr]">
          <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-foreground">{editingPoolId ? '编辑域名池' : '新增域名池'}</h2>
              {editingPoolId && (
                <Button variant="ghost" size="sm" onClick={() => { setEditingPoolId(null); setPoolForm(emptyPoolForm); setPoolErrors({}); }}>
                  <XCircle className="h-4 w-4" />
                  取消
                </Button>
              )}
            </div>
            <FormField id="http-pool-wildcard-domain" label="通配根域" error={poolErrors.wildcardDomain}>
              <Input
                id="http-pool-wildcard-domain"
                value={poolForm.wildcardDomain}
                onChange={(event) => setPoolField('wildcardDomain', event.target.value)}
                placeholder="*.apps.example.com"
                aria-invalid={!!poolErrors.wildcardDomain}
                aria-describedby={poolErrors.wildcardDomain ? 'http-pool-wildcard-domain-error' : undefined}
                className={poolErrors.wildcardDomain ? 'border-destructive focus-visible:ring-destructive' : undefined}
              />
            </FormField>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Label htmlFor="http-pool-enabled" className="flex items-center gap-2 text-sm font-normal">
                <input id="http-pool-enabled" type="checkbox" checked={poolForm.enabled} onChange={(event) => setPoolField('enabled', event.target.checked)} />
                启用
              </Label>
              <Label htmlFor="http-pool-https-enabled" className="flex items-center gap-2 text-sm font-normal">
                <input id="http-pool-https-enabled" type="checkbox" checked={poolForm.httpsEnabled} onChange={(event) => setPoolField('httpsEnabled', event.target.checked)} />
                入口 HTTPS
              </Label>
            </div>
            <FormField id="http-pool-certificate-pem" label="证书 PEM" error={poolErrors.certificatePem}>
              <textarea
                id="http-pool-certificate-pem"
                className={`min-h-24 w-full rounded-md border bg-background px-3 py-2 text-xs font-mono ${poolErrors.certificatePem ? 'border-destructive' : 'border-input'}`}
                value={poolForm.certificatePem}
                onChange={(event) => setPoolField('certificatePem', event.target.value)}
                aria-invalid={!!poolErrors.certificatePem}
                aria-describedby={poolErrors.certificatePem ? 'http-pool-certificate-pem-error' : undefined}
              />
            </FormField>
            <FormField id="http-pool-private-key-pem" label="私钥 PEM" error={poolErrors.privateKeyPem}>
              <textarea
                id="http-pool-private-key-pem"
                className={`min-h-24 w-full rounded-md border bg-background px-3 py-2 text-xs font-mono ${poolErrors.privateKeyPem ? 'border-destructive' : 'border-input'}`}
                value={poolForm.privateKeyPem}
                onChange={(event) => setPoolField('privateKeyPem', event.target.value)}
                aria-invalid={!!poolErrors.privateKeyPem}
                aria-describedby={poolErrors.privateKeyPem ? 'http-pool-private-key-pem-error' : undefined}
              />
            </FormField>
            <Button className="w-full" onClick={handleSavePool} disabled={savePool.isPending}>
              <Plus className="h-4 w-4" />
              保存域名池
            </Button>
          </div>

          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {pools.isError ? (
              <div className="p-4">
                <QueryErrorNotice
                  title="域名池加载失败"
                  error={pools.error}
                  onRetry={() => pools.refetch()}
                  isRetrying={pools.isFetching}
                />
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">通配根域</th>
                    <th className="text-left font-medium px-3 py-2">状态</th>
                    <th className="text-left font-medium px-3 py-2">证书</th>
                    <th className="text-right font-medium px-3 py-2">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {poolRows.length === 0 ? (
                    <tr><td className="px-3 py-8 text-center text-muted-foreground" colSpan={4}>暂无域名池</td></tr>
                  ) : poolRows.map((pool) => (
                    <tr key={pool.id} className="border-t border-border">
                      <td className="px-3 py-2 font-medium">{pool.wildcardDomain}</td>
                      <td className="px-3 py-2">
                        <div className="flex gap-2">
                          <Badge variant={pool.enabled ? 'success' : 'outline'}>{pool.enabled ? '启用' : '禁用'}</Badge>
                          <Badge variant={pool.httpsEnabled ? 'secondary' : 'outline'}>{pool.httpsEnabled ? 'HTTPS' : 'HTTP'}</Badge>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-mono text-xs break-all">{pool.certificateFingerprint ?? '-'}</div>
                        <div className="text-xs text-muted-foreground">{pool.certificateNotAfter ? `过期 ${formatTime(pool.certificateNotAfter)}` : '未配置证书'}</div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`编辑域名池 ${pool.wildcardDomain}`} onClick={() => {
                            setEditingPoolId(pool.id);
                            setPoolErrors({});
                            setPoolForm({
                              wildcardDomain: pool.wildcardDomain,
                              enabled: pool.enabled,
                              httpsEnabled: pool.httpsEnabled,
                              certificatePem: '',
                              privateKeyPem: '',
                            });
                          }}>
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label={`删除域名池 ${pool.wildcardDomain}`} onClick={() => setDeletingPool(pool)} disabled={deletePool.isPending}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      <AlertDialog open={deletingBinding !== null} onOpenChange={(open) => {
        if (!open && !deleteBinding.isPending) setDeletingBinding(null);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除域名绑定？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后 {deletingBinding?.hostname ?? '该域名'} 将不再转发到目标容器。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBinding.isPending}>取消</AlertDialogCancel>
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deletingBinding && deleteBinding.mutate(deletingBinding.id)}
              disabled={deleteBinding.isPending || !deletingBinding}
            >
              {deleteBinding.isPending ? '删除中...' : '删除'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deletingPool !== null} onOpenChange={(open) => {
        if (!open && !deletePool.isPending) setDeletingPool(null);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除域名池？</AlertDialogTitle>
            <AlertDialogDescription>
              删除 {deletingPool?.wildcardDomain ?? '该域名池'} 后，依赖它的绑定将无法继续匹配入口域名。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePool.isPending}>取消</AlertDialogCancel>
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deletingPool && deletePool.mutate(deletingPool.id)}
              disabled={deletePool.isPending || !deletingPool}
            >
              {deletePool.isPending ? '删除中...' : '删除'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-foreground">{value}</div>
    </div>
  );
}

function FormField({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {error && <p id={`${id}-error`} className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function StatusBadge({ status }: { status: HttpProxyBindingStatus }) {
  if (status === 'ready') return <Badge variant="success"><CheckCircle2 className="h-3 w-3" />正常</Badge>;
  if (status === 'disabled') return <Badge variant="outline">禁用</Badge>;
  return <Badge variant="warning"><AlertTriangle className="h-3 w-3" />警告</Badge>;
}

function bindingErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return '域名已被占用';
  return errorMessage(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请稍后重试';
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

function QueryErrorNotice({ title, error, onRetry, isRetrying }: { title: string; error: unknown; onRetry: () => void; isRetrying: boolean }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="font-medium">{title}</div>
          <div className="text-xs opacity-90">{errorMessage(error)}</div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={isRetrying}>
          <RefreshCw className={`h-3.5 w-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
          重试
        </Button>
      </div>
    </div>
  );
}

function InlineErrorNotice({ title, error, onRetry, isRetrying }: { title: string; error: unknown; onRetry: () => void; isRetrying: boolean }) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
      <div className="flex items-center justify-between gap-2">
        <span>{title}：{errorMessage(error)}</span>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-destructive" onClick={onRetry} disabled={isRetrying}>
          重试
        </Button>
      </div>
    </div>
  );
}

function withoutFieldError<T extends string>(errors: Partial<Record<T, string>>, field: T): Partial<Record<T, string>> {
  const next = { ...errors };
  delete next[field];
  return next;
}

function firstError(errors: Record<string, string | undefined>): string {
  return Object.values(errors).find(Boolean) ?? '请修正高亮字段后再保存';
}

function validateBindingForm(form: typeof emptyBindingForm, containers: ContainerOption[]): { errors: BindingFormErrors; payload: SaveBindingPayload | null } {
  const errors: BindingFormErrors = {};
  const hostname = normalizeHttpProxyHostname(form.hostname);
  const targetPort = Number(form.targetPort);

  if (!hostname) {
    errors.hostname = '请输入域名';
  } else if (hostname.startsWith('*.') || hostname.includes('*')) {
    errors.hostname = '绑定域名不能使用通配符';
  } else if (!isValidHostname(hostname)) {
    errors.hostname = '请输入有效域名，如 app.apps.example.com';
  }

  if (!form.containerId) {
    errors.containerId = '请选择目标容器';
  } else if (containers.length > 0 && !containers.some((container) => container.id === form.containerId)) {
    errors.containerId = '请选择有效容器';
  }

  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    errors.targetPort = '端口必须是 1 到 65535 之间的整数';
  }

  if (Object.keys(errors).length > 0) return { errors, payload: null };
  return {
    errors,
    payload: {
      hostname,
      containerId: form.containerId,
      targetPort,
    },
  };
}

function validatePoolForm(form: typeof emptyPoolForm, isEditing: boolean): { errors: PoolFormErrors; payload: SavePoolPayload | null } {
  const errors: PoolFormErrors = {};
  const rawWildcardDomain = form.wildcardDomain.trim();
  const wildcardDomain = rawWildcardDomain ? normalizeHttpProxyWildcardDomain(rawWildcardDomain) : '';
  const certificatePem = form.certificatePem.trim();
  const privateKeyPem = form.privateKeyPem.trim();

  if (!rawWildcardDomain) {
    errors.wildcardDomain = '请输入通配根域';
  } else if (!isValidWildcardDomain(wildcardDomain)) {
    errors.wildcardDomain = '请输入有效通配域名，如 *.apps.example.com';
  }

  if ((certificatePem && !privateKeyPem) || (!certificatePem && privateKeyPem)) {
    const message = '证书 PEM 与私钥 PEM 必须成对填写';
    errors.certificatePem = message;
    errors.privateKeyPem = message;
  }

  if (Object.keys(errors).length > 0) return { errors, payload: null };

  const payload: SavePoolPayload = {
    wildcardDomain,
    enabled: form.enabled,
    httpsEnabled: form.httpsEnabled,
  };
  if (!isEditing || certificatePem || privateKeyPem) {
    payload.certificatePem = certificatePem || null;
    payload.privateKeyPem = privateKeyPem || null;
  }
  return { errors, payload };
}

function isValidWildcardDomain(wildcardDomain: string): boolean {
  if (!wildcardDomain.startsWith('*.')) return false;
  return isValidHostname(wildcardDomain.slice(2));
}

function isValidHostname(hostname: string): boolean {
  if (hostname.length > 253) return false;
  const labels = hostname.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
