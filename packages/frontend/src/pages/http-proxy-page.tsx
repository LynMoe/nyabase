import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Globe, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  zCreateHttpProxyBindingRequest,
  type ContainerDto,
  type HttpDomainPoolPublicDto,
  type HttpProxyBindingDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { ApiError } from '../lib/api-error.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from '../hooks/use-toast.js';
import {
  emptyIfNotFound,
  httpProxyBindingStatusLabel,
  httpProxyErrorMessage,
  httpProxyWarningLabel,
} from '../lib/http-proxy.js';

export default function HttpProxyPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<HttpProxyBindingDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HttpProxyBindingDto | null>(null);
  const bindingsQuery = useQuery({
    queryKey: queryKeys.httpProxy.bindings,
    queryFn: () => api.get<HttpProxyBindingDto[]>('/http-proxy/bindings'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`/http-proxy/bindings/${id}`),
    onSuccess: () => {
      toast({ title: '发布已删除' });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.httpProxy.bindings });
    },
    onError: (error) => toast({ title: '删除失败', description: httpProxyErrorMessage(error), variant: 'destructive' }),
  });
  const bindings = bindingsQuery.data ?? [];

  return (
    <div className="space-y-5 px-4 py-4 md:px-6" data-testid="http-proxy">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">HTTP 发布</h1>
          <p className="text-sm text-muted-foreground">
            把容器端口发布到域名。主机名必须匹配管理员已启用的通配域名。
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={() => { void bindingsQuery.refetch(); }} aria-label="刷新 HTTP 发布">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建发布</Button>
        </div>
      </div>
      {bindingsQuery.isLoading ? (
        <QueryLoadingState label="加载 HTTP 发布..." />
      ) : bindingsQuery.isError ? (
        <QueryErrorState error={bindingsQuery.error} resourceName="HTTP 发布" onRetry={() => { void bindingsQuery.refetch(); }} />
      ) : bindings.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Globe className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              暂无 HTTP 发布。创建后即可把容器端口发布到域名。
            </p>
            <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建发布</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {bindings.map((binding) => (
            <BindingCard
              key={binding.id}
              binding={binding}
              onEdit={() => setEditTarget(binding)}
              onDelete={() => setDeleteTarget(binding)}
            />
          ))}
        </div>
      )}
      <BindingFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editTarget && (
        <BindingFormDialog
          binding={editTarget}
          open
          onOpenChange={(open) => { if (!open) setEditTarget(null); }}
        />
      )}
      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 HTTP 发布？</DialogTitle>
            <DialogDescription>
              将删除主机名「{deleteTarget?.hostname}」的发布绑定。域名将不再转发到该容器端口。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button
              variant="destructive"
              onClick={() => { if (deleteTarget) remove.mutate(deleteTarget.id); }}
              disabled={remove.isPending}
            >
              {remove.isPending ? '删除中...' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BindingCard({
  binding,
  onEdit,
  onDelete,
}: {
  binding: HttpProxyBindingDto;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const warning = httpProxyWarningLabel(binding.warningReasons);
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex min-w-0 items-center gap-2 text-base">
            <Globe className="h-4 w-4 shrink-0" />
            <span className="truncate font-mono text-sm">{binding.hostname}</span>
          </CardTitle>
          <Badge variant={binding.status === 'ready' ? 'success' : binding.status === 'warning' ? 'warning' : 'secondary'}>
            {httpProxyBindingStatusLabel(binding.status)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Info label="容器" value={binding.containerName ?? binding.containerId} />
          <Info label="目标端口" value={String(binding.targetPort)} />
          <Info label="HTTPS" value={binding.entryHttpsEnabled ? '已启用' : '未启用'} />
          <Info label="域名池" value={binding.domainPool} mono />
        </div>
        {(warning || binding.warningMessage) && (
          <p className="text-xs text-destructive">{warning || binding.warningMessage}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onEdit}><Pencil className="h-3.5 w-3.5" />编辑</Button>
          <Button size="sm" variant="destructive" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" />删除</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function BindingFormDialog({
  binding,
  open,
  onOpenChange,
}: {
  binding?: HttpProxyBindingDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [hostname, setHostname] = useState(binding?.hostname ?? '');
  const [containerId, setContainerId] = useState(binding?.containerId ?? '');
  const [targetPort, setTargetPort] = useState(binding ? String(binding.targetPort) : '80');
  const [error, setError] = useState<string | null>(null);
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.userList,
    queryFn: () => api.get<ContainerDto[]>('/containers'),
    enabled: open,
  });
  const poolsQuery = useQuery({
    queryKey: queryKeys.httpProxy.domainPools,
    queryFn: () => api.get<HttpDomainPoolPublicDto[]>('/http-proxy/domain-pools')
      .catch(emptyIfNotFound<HttpDomainPoolPublicDto[]>([])),
    enabled: open,
    retry: (count, queryError) => (queryError instanceof ApiError && queryError.status === 404 ? false : count < 2),
  });
  const create = useMutation({
    mutationFn: (body: { hostname: string; containerId: string; targetPort: number }) =>
      api.post<HttpProxyBindingDto>('/http-proxy/bindings', body),
    onSuccess: () => {
      toast({ title: '发布已创建' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.httpProxy.bindings });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(httpProxyErrorMessage(mutationError)),
  });
  const patch = useMutation({
    mutationFn: (body: { hostname: string; containerId: string; targetPort: number }) =>
      api.patch<HttpProxyBindingDto>(`/http-proxy/bindings/${binding?.id ?? ''}`, body),
    onSuccess: () => {
      toast({ title: '发布已更新' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.httpProxy.bindings });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(httpProxyErrorMessage(mutationError)),
  });
  useEffect(() => {
    if (!open) return;
    setHostname(binding?.hostname ?? '');
    setContainerId(binding?.containerId ?? '');
    setTargetPort(binding ? String(binding.targetPort) : '80');
    setError(null);
  }, [binding, open]);
  const containers = containersQuery.data ?? [];
  const pools = poolsQuery.data ?? [];
  const submit = () => {
    setError(null);
    const port = Number(targetPort);
    if (!hostname.trim()) {
      setError('请输入主机名');
      return;
    }
    if (!containerId) {
      setError('请选择容器');
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError('目标端口必须是 1 到 65535 的整数');
      return;
    }
    const parsed = zCreateHttpProxyBindingRequest.safeParse({
      hostname: hostname.trim(),
      containerId,
      targetPort: port,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查发布参数');
      return;
    }
    if (binding) patch.mutate(parsed.data);
    else create.mutate(parsed.data);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="http-proxy-binding-form">
        <DialogHeader>
          <DialogTitle>{binding ? '编辑 HTTP 发布' : '新建 HTTP 发布'}</DialogTitle>
          <DialogDescription>
            主机名必须匹配已启用的通配域名（例如 *.example.com 对应 app.example.com）。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="http-proxy-hostname">主机名</Label>
            <Input
              id="http-proxy-hostname"
              className="font-mono"
              value={hostname}
              placeholder="app.example.com"
              onChange={(event) => { setHostname(event.target.value); setError(null); }}
            />
          </div>
          {pools.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              已启用通配域名：{pools.map((pool) => pool.wildcardDomain).join('、')}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {poolsQuery.isLoading
                ? '正在加载通配域名…'
                : '当前没有已启用的通配域名，请联系管理员在「HTTP 代理」中创建。'}
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="http-proxy-container">容器</Label>
            <select
              id="http-proxy-container"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={containerId}
              onChange={(event) => { setContainerId(event.target.value); setError(null); }}
            >
              <option value="">{containersQuery.isLoading ? '加载容器…' : '选择容器'}</option>
              {containers.map((container) => (
                <option key={container.id} value={container.id}>
                  {container.name} · {container.serverName}
                </option>
              ))}
            </select>
            {!containersQuery.isLoading && containers.length === 0 && (
              <p className="text-xs text-muted-foreground">
                还没有容器。<Link to="/containers" className="underline">去创建容器</Link>
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="http-proxy-port">目标端口</Label>
            <Input
              id="http-proxy-port"
              type="number"
              min="1"
              max="65535"
              value={targetPort}
              onChange={(event) => { setTargetPort(event.target.value); setError(null); }}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={create.isPending || patch.isPending}>
            {create.isPending || patch.isPending ? '提交中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={mono ? 'break-all font-mono text-xs' : 'break-all text-sm'}>{value}</p>
    </div>
  );
}

