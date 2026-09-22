import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Globe, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  httpProxyWildcardSuffix,
  zCreateHttpProxyBindingRequest,
  type ContainerDto,
  type HttpDomainPoolPublicDto,
  type HttpProxyBindingDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { ApiError } from '../lib/api-error.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { FormField } from '../components/layout/form-field.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from '../hooks/use-toast.js';
import {
  composeHttpProxyHostname,
  emptyIfNotFound,
  httpProxyBindingStatusLabel,
  httpProxyDomainRootLabel,
  httpProxyErrorMessage,
  httpProxyWarningLabel,
  isHttpProxyPrefixLabel,
  splitHttpProxyHostname,
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
  const poolsQuery = useQuery({
    queryKey: queryKeys.httpProxy.domainPools,
    queryFn: () => api.get<HttpDomainPoolPublicDto[]>('/http-proxy/domain-pools')
      .catch(emptyIfNotFound<HttpDomainPoolPublicDto[]>([])),
    retry: (count, queryError) => (queryError instanceof ApiError && queryError.status === 404 ? false : count < 2),
  });
  const pools = poolsQuery.data ?? [];
  const canCreate = !poolsQuery.isLoading && pools.length > 0;
  const createBlockedHint = poolsQuery.isLoading
    ? '正在加载域名…'
    : '管理员尚未配置通配域名';
  const createButton = (
    <Button
      onClick={() => setCreateOpen(true)}
      disabled={!canCreate}
      title={canCreate ? undefined : createBlockedHint}
    >
      <Plus className="h-4 w-4" />新建发布
    </Button>
  );
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`/http-proxy/bindings/${id}`),
    onSuccess: () => {
      toast({ title: '发布已删除' });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.httpProxy.bindings });
    },
    onError: (error) => toast({ title: '删除失败', description: httpProxyErrorMessage(error), variant: 'destructive' }),
  });
  return (
    <Page testId="http-proxy">
      <PageHeader
        title="HTTP 发布"
        actions={
          <>
            <Button variant="outline" size="icon" onClick={() => { void bindingsQuery.refetch(); }} aria-label="刷新 HTTP 发布">
              <RefreshCw className="h-4 w-4" />
            </Button>
            {createButton}
          </>
        }
      />
      <QueryView
        query={bindingsQuery}
        resourceName="HTTP 发布"
        loadingLabel="加载 HTTP 发布..."
        showEmpty={bindingsQuery.data?.length === 0}
        empty={
          <EmptyState
            icon={Globe}
            title={canCreate ? '暂无 HTTP 发布。' : '暂无 HTTP 发布。管理员配置通配域名后才能新建。'}
            action={createButton}
          />
        }
      >
        {(items) => (
          <SectionCard flush>
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>主机名</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>容器</TableHead>
                <TableHead>端口</TableHead>
                <TableHead>HTTPS</TableHead>
                <TableHead>域名池</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((binding) => (
                <BindingRow
                  key={binding.id}
                  binding={binding}
                  onEdit={() => setEditTarget(binding)}
                  onDelete={() => setDeleteTarget(binding)}
                />
              ))}
            </TableBody>
          </Table>
          </SectionCard>
        )}
      </QueryView>
      <BindingFormDialog pools={pools} open={createOpen} onOpenChange={setCreateOpen} />
      {editTarget && (
        <BindingFormDialog
          binding={editTarget}
          pools={pools}
          open
          onOpenChange={(open) => { if (!open) setEditTarget(null); }}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除 HTTP 发布？"
        description={`将删除主机名「${deleteTarget?.hostname}」的发布绑定。域名将不再转发到该容器端口。`}
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={remove.isPending}
        onConfirm={() => { if (deleteTarget) remove.mutate(deleteTarget.id); }}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      />
    </Page>
  );
}

function BindingRow({
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
    <TableRow className="cursor-pointer" onClick={onEdit}>
      <TableCell className="font-mono">{binding.hostname}</TableCell>
      <TableCell className="whitespace-normal">
        <Badge variant={binding.status === 'ready' ? 'success' : binding.status === 'warning' ? 'warning' : 'secondary'}>
          {httpProxyBindingStatusLabel(binding.status)}
        </Badge>
        {(warning || binding.warningMessage) ? (
          <p className="mt-1 text-xs text-destructive">{warning || binding.warningMessage}</p>
        ) : null}
      </TableCell>
      <TableCell>{binding.containerName ?? binding.containerId}</TableCell>
      <TableCell>{binding.targetPort}</TableCell>
      <TableCell>{binding.entryHttpsEnabled ? '已启用' : '未启用'}</TableCell>
      <TableCell className="font-mono">{binding.domainPool}</TableCell>
      <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onEdit}><Pencil className="h-3.5 w-3.5" />编辑</Button>
          <Button size="sm" variant="destructive" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" />删除</Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function BindingFormDialog({
  binding,
  pools,
  open,
  onOpenChange,
}: {
  binding?: HttpProxyBindingDto;
  pools: HttpDomainPoolPublicDto[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [prefix, setPrefix] = useState('');
  const [poolId, setPoolId] = useState('');
  const [containerId, setContainerId] = useState(binding?.containerId ?? '');
  const [targetPort, setTargetPort] = useState(binding ? String(binding.targetPort) : '80');
  const [error, setError] = useState<string | null>(null);
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.userList,
    queryFn: () => api.get<ContainerDto[]>('/containers'),
    enabled: open,
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
    const split = binding ? splitHttpProxyHostname(binding.hostname, pools) : null;
    setPrefix(split?.prefix ?? '');
    setPoolId(split?.poolId ?? pools[0]?.id ?? '');
    setContainerId(binding?.containerId ?? '');
    setTargetPort(binding ? String(binding.targetPort) : '80');
    setError(null);
  }, [binding, open, pools]);
  const containers = containersQuery.data ?? [];
  const selectedPool = pools.find((pool) => pool.id === poolId) ?? pools[0];
  const suffix = selectedPool ? httpProxyWildcardSuffix(selectedPool.wildcardDomain) : '';
  let hostnamePreview: string | undefined;
  try {
    if (selectedPool && isHttpProxyPrefixLabel(prefix)) {
      hostnamePreview = composeHttpProxyHostname(prefix, selectedPool.wildcardDomain);
    }
  } catch {
    hostnamePreview = undefined;
  }
  const submit = () => {
    setError(null);
    const port = Number(targetPort);
    if (!selectedPool) {
      setError('管理员尚未配置通配域名');
      return;
    }
    if (!isHttpProxyPrefixLabel(prefix)) {
      setError('请填写单节主机前缀，例如 app');
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
    let hostname: string;
    try {
      hostname = composeHttpProxyHostname(prefix, selectedPool.wildcardDomain);
    } catch {
      setError('前缀与域名根无法组成有效主机名');
      return;
    }
    const parsed = zCreateHttpProxyBindingRequest.safeParse({
      hostname,
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
            选择域名根，只填写前缀。完整主机名形如 app.example.com。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {pools.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              当前没有已启用的通配域名，请联系管理员在「HTTP 代理」中创建。
            </p>
          ) : (
            <>
              <FormField id="http-proxy-domain-root" label="域名根">
                <Select
                  value={selectedPool?.id}
                  onValueChange={(value) => { setPoolId(value); setError(null); }}
                >
                  <SelectTrigger id="http-proxy-domain-root">
                    <SelectValue placeholder="选择域名根" />
                  </SelectTrigger>
                  <SelectContent>
                    {pools.map((pool) => (
                      <SelectItem key={pool.id} value={pool.id}>
                        {httpProxyDomainRootLabel(pool.wildcardDomain)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField
                id="http-proxy-prefix"
                label="主机前缀"
                hint={hostnamePreview ? `完整主机名 ${hostnamePreview}` : undefined}
              >
                <div className="flex items-center gap-2">
                  <Input
                    id="http-proxy-prefix"
                    className="font-mono"
                    value={prefix}
                    placeholder="app"
                    autoComplete="off"
                    onChange={(event) => {
                      setPrefix(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
                      setError(null);
                    }}
                  />
                  <span className="shrink-0 font-mono text-sm text-muted-foreground">{suffix}</span>
                </div>
              </FormField>
            </>
          )}
          <FormField id="http-proxy-container" label="容器">
            <Select
              value={containerId || undefined}
              onValueChange={(value) => { setContainerId(value); setError(null); }}
            >
              <SelectTrigger id="http-proxy-container">
                <SelectValue placeholder={containersQuery.isLoading ? '加载容器…' : '选择容器'} />
              </SelectTrigger>
              <SelectContent>
                {containers.map((container) => (
                  <SelectItem key={container.id} value={container.id}>
                    {container.name} · {container.serverName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!containersQuery.isLoading && containers.length === 0 && (
              <p className="text-xs text-muted-foreground">
                还没有容器。<Link to="/containers" className="underline">去创建容器</Link>
              </p>
            )}
          </FormField>
          <FormField id="http-proxy-port" label="目标端口">
            <Input
              id="http-proxy-port"
              type="number"
              min="1"
              max="65535"
              value={targetPort}
              onChange={(event) => { setTargetPort(event.target.value); setError(null); }}
            />
          </FormField>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            onClick={submit}
            disabled={create.isPending || patch.isPending || pools.length === 0}
          >
            {create.isPending || patch.isPending ? '提交中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}



