import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Edit, Globe2, Plus, RefreshCw, Save, Trash2, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Capability, type ContainerStatus, type HttpProxyBindingStatus, type HttpProxyTargetProtocol, type HttpProxyWarningReason } from '@nyabase/common';
import { api, ApiError } from '../lib/api.js';
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
  containerStatus: ContainerStatus | 'deleted' | 'missing' | null;
  targetPort: number;
  targetProtocol: HttpProxyTargetProtocol;
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
  targetProtocol: 'http' as HttpProxyTargetProtocol,
};

const emptyPoolForm = {
  wildcardDomain: '',
  enabled: true,
  httpsEnabled: false,
  certificatePem: '',
  privateKeyPem: '',
};

export default function HttpProxyPage() {
  const qc = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const canManageSettings = user?.capabilities.includes(Capability.ManageSystemSettings) ?? false;
  const canViewMetrics = user?.capabilities.includes(Capability.ViewMetricsAll) ?? false;
  const [bindingForm, setBindingForm] = useState(emptyBindingForm);
  const [editingBindingId, setEditingBindingId] = useState<string | null>(null);
  const [poolForm, setPoolForm] = useState(emptyPoolForm);
  const [editingPoolId, setEditingPoolId] = useState<string | null>(null);

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
    mutationFn: async () => {
      const payload = {
        hostname: bindingForm.hostname,
        containerId: bindingForm.containerId,
        targetPort: Number(bindingForm.targetPort),
        targetProtocol: bindingForm.targetProtocol,
      };
      return editingBindingId
        ? api.patch<Binding>(`/v2/http-proxy/bindings/${editingBindingId}`, payload)
        : api.post<Binding>('/v2/http-proxy/bindings', payload);
    },
    onSuccess: () => {
      setBindingForm(emptyBindingForm);
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
      qc.invalidateQueries({ queryKey: ['http-proxy-bindings'] });
      toast({ title: '域名绑定已删除' });
    },
    onError: (error) => toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const savePool = useMutation({
    mutationFn: async () => {
      const payload = {
        wildcardDomain: poolForm.wildcardDomain,
        enabled: poolForm.enabled,
        httpsEnabled: poolForm.httpsEnabled,
        certificatePem: poolForm.certificatePem.trim() || null,
        privateKeyPem: poolForm.privateKeyPem.trim() || null,
      };
      return editingPoolId
        ? api.patch<DomainPool>(`/admin/http-proxy/domain-pools/${editingPoolId}`, payload)
        : api.post<DomainPool>('/admin/http-proxy/domain-pools', payload);
    },
    onSuccess: () => {
      setPoolForm(emptyPoolForm);
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
      qc.invalidateQueries({ queryKey: ['http-proxy-domain-pools'] });
      qc.invalidateQueries({ queryKey: ['http-proxy-bindings'] });
      toast({ title: '域名池已删除' });
    },
    onError: (error) => toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const rows = bindings.data ?? [];

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">HTTP 反代</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {canViewMetrics && status.data?.updatedAt ? `最后更新 ${formatTime(status.data.updatedAt)}` : `${rows.length} 个域名绑定`}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => bindings.refetch()} disabled={bindings.isFetching}>
          <RefreshCw className={`h-4 w-4 ${bindings.isFetching ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {canViewMetrics && (
        <section className="grid gap-3 sm:grid-cols-3">
          <Metric label="在线代理" value={(status.data?.connectedProxies ?? 0).toString()} />
          <Metric label="累计请求" value={(status.data?.totalRequests ?? 0).toString()} />
          <Metric label="拒绝请求" value={(status.data?.totalRejectedRequests ?? 0).toString()} />
        </section>
      )}

      <section className="grid gap-4 xl:grid-cols-[360px_1fr]">
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-foreground">{editingBindingId ? '编辑绑定' : '新增绑定'}</h2>
            {editingBindingId && (
              <Button variant="ghost" size="sm" onClick={() => { setEditingBindingId(null); setBindingForm(emptyBindingForm); }}>
                <XCircle className="h-4 w-4" />
                取消
              </Button>
            )}
          </div>
          <FormField label="域名">
            <Input value={bindingForm.hostname} onChange={(event) => setBindingForm((form) => ({ ...form, hostname: event.target.value }))} placeholder="app.apps.example.com" />
          </FormField>
          <FormField label="目标容器">
            <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={bindingForm.containerId} onChange={(event) => setBindingForm((form) => ({ ...form, containerId: event.target.value }))}>
              <option value="">选择容器</option>
              {containerOptions.map((container) => <option key={container.id} value={container.id}>{container.name}</option>)}
            </select>
          </FormField>
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <FormField label="端口">
              <Input type="number" min={1} max={65535} value={bindingForm.targetPort} onChange={(event) => setBindingForm((form) => ({ ...form, targetPort: event.target.value }))} />
            </FormField>
            <FormField label="上游协议">
              <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={bindingForm.targetProtocol} onChange={(event) => setBindingForm((form) => ({ ...form, targetProtocol: event.target.value as HttpProxyTargetProtocol }))}>
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
              </select>
            </FormField>
          </div>
          <Button className="w-full" onClick={() => saveBinding.mutate()} disabled={saveBinding.isPending}>
            <Save className="h-4 w-4" />
            保存绑定
          </Button>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-card">
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
                  <td className="px-3 py-2 uppercase">{binding.targetProtocol}:{binding.targetPort}</td>
                  <td className="px-3 py-2">{binding.entryHttpsEnabled ? '开启' : '关闭'}</td>
                  <td className="px-3 py-2"><StatusBadge status={binding.status} /></td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" disabled={!binding.mine} onClick={() => {
                        setEditingBindingId(binding.id);
                        setBindingForm({
                          hostname: binding.hostname,
                          containerId: binding.containerId,
                          targetPort: String(binding.targetPort),
                          targetProtocol: binding.targetProtocol,
                        });
                      }}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" disabled={!binding.mine || deleteBinding.isPending} onClick={() => deleteBinding.mutate(binding.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {canManageSettings && (
        <section className="grid gap-4 xl:grid-cols-[360px_1fr]">
          <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-foreground">{editingPoolId ? '编辑域名池' : '新增域名池'}</h2>
              {editingPoolId && (
                <Button variant="ghost" size="sm" onClick={() => { setEditingPoolId(null); setPoolForm(emptyPoolForm); }}>
                  <XCircle className="h-4 w-4" />
                  取消
                </Button>
              )}
            </div>
            <FormField label="通配根域">
              <Input value={poolForm.wildcardDomain} onChange={(event) => setPoolForm((form) => ({ ...form, wildcardDomain: event.target.value }))} placeholder="*.apps.example.com" />
            </FormField>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={poolForm.enabled} onChange={(event) => setPoolForm((form) => ({ ...form, enabled: event.target.checked }))} />启用</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={poolForm.httpsEnabled} onChange={(event) => setPoolForm((form) => ({ ...form, httpsEnabled: event.target.checked }))} />入口 HTTPS</label>
            </div>
            <FormField label="证书 PEM">
              <textarea className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono" value={poolForm.certificatePem} onChange={(event) => setPoolForm((form) => ({ ...form, certificatePem: event.target.value }))} />
            </FormField>
            <FormField label="私钥 PEM">
              <textarea className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono" value={poolForm.privateKeyPem} onChange={(event) => setPoolForm((form) => ({ ...form, privateKeyPem: event.target.value }))} />
            </FormField>
            <Button className="w-full" onClick={() => savePool.mutate()} disabled={savePool.isPending}>
              <Plus className="h-4 w-4" />
              保存域名池
            </Button>
          </div>

          <div className="overflow-hidden rounded-lg border border-border bg-card">
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
                {(pools.data ?? []).length === 0 ? (
                  <tr><td className="px-3 py-8 text-center text-muted-foreground" colSpan={4}>暂无域名池</td></tr>
                ) : (pools.data ?? []).map((pool) => (
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
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => {
                          setEditingPoolId(pool.id);
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
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => deletePool.mutate(pool.id)} disabled={deletePool.isPending}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
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

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
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
