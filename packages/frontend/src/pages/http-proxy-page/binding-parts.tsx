import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  httpProxyWildcardSuffix,
  zCreateHttpProxyBindingRequest,
  type ContainerDto,
  type HttpDomainPoolPublicDto,
  type HttpProxyBindingDto,
} from '@nyabase/common';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select.js';
import { FormField } from '../../components/layout/form-field.js';
import { useOpenSession } from '../../hooks/use-dom-state.js';
import { toast } from '../../hooks/use-toast.js';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import {
  composeHttpProxyHostname,
  httpProxyBindingStatusLabel,
  httpProxyDomainRootLabel,
  httpProxyErrorMessage,
  isHttpProxyPrefixLabel,
  splitHttpProxyHostname,
  userVisibleBindingState,
} from '../../lib/http-proxy.js';
import { BindingTrafficCells } from '../../components/http-proxy/binding-traffic.js';
import { Badge } from '../../components/ui/badge.js';
import { TableCell, TableRow } from '../../components/ui/table.js';

type BindingBody = { hostname: string; containerId: string; targetPort: number };

function previewHostname(prefix: string, wildcardDomain: string): string | undefined {
  try {
    return isHttpProxyPrefixLabel(prefix) ? composeHttpProxyHostname(prefix, wildcardDomain) : undefined;
  } catch {
    return undefined;
  }
}

/** Create or update the binding; success closes the dialog. */
function useBindingSave(
  binding: HttpProxyBindingDto | undefined,
  onClose: () => void,
  setError: (message: string) => void,
) {
  const queryClient = useQueryClient();
  const saved = (title: string) => {
    toast({ title });
    void queryClient.invalidateQueries({ queryKey: queryKeys.httpProxy.bindings });
    onClose();
  };
  const save = useMutation({
    mutationFn: (body: BindingBody) => (binding
      ? api.patch<HttpProxyBindingDto>(`/http-proxy/bindings/${binding.id}`, body)
      : api.post<HttpProxyBindingDto>('/http-proxy/bindings', body)),
    onSuccess: () => saved(binding ? '发布已更新' : '发布已创建'),
    onError: (mutationError) => setError(httpProxyErrorMessage(mutationError)),
  });
  return save;
}

interface BindingFormDialogProps {
  binding?: HttpProxyBindingDto;
  pools: HttpDomainPoolPublicDto[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BindingFormDialog(props: BindingFormDialogProps) {
  return <BindingFormBody key={useOpenSession(props.open)} {...props} />;
}

function BindingFormBody({ binding, pools, open, onOpenChange }: BindingFormDialogProps) {
  const split = binding ? splitHttpProxyHostname(binding.hostname, pools) : null;
  const [prefix, setPrefix] = useState(split?.prefix ?? '');
  const [poolId, setPoolId] = useState(split?.poolId ?? pools[0]?.id ?? '');
  const [containerId, setContainerId] = useState(binding?.containerId ?? '');
  const [targetPort, setTargetPort] = useState(binding ? String(binding.targetPort) : '80');
  const [error, setError] = useState<string | null>(null);
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.userList,
    queryFn: () => api.get<ContainerDto[]>('/containers'),
    enabled: open,
  });
  const containers = containersQuery.data ?? [];
  const save = useBindingSave(binding, () => onOpenChange(false), setError);
  const selectedPool = pools.find((pool) => pool.id === poolId) ?? pools[0];
  const suffix = selectedPool ? httpProxyWildcardSuffix(selectedPool.wildcardDomain) : '';
  const hostnamePreview = selectedPool ? previewHostname(prefix, selectedPool.wildcardDomain) : undefined;
  const edit = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setError(null);
  };

  const submit = () => {
    setError(null);
    const port = Number(targetPort);
    const fail = (message: string) => setError(message);
    if (!selectedPool) return fail('管理员尚未配置通配域名');
    if (!isHttpProxyPrefixLabel(prefix)) return fail('请填写单节主机前缀，例如 app');
    if (!containerId) return fail('请选择容器');
    if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('目标端口必须是 1 到 65535 的整数');
    let hostname: string;
    try {
      hostname = composeHttpProxyHostname(prefix, selectedPool.wildcardDomain);
    } catch {
      return fail('前缀与域名根无法组成有效主机名');
    }
    const parsed = zCreateHttpProxyBindingRequest.safeParse({ hostname, containerId, targetPort: port });
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? '请检查发布参数');
    save.mutate(parsed.data);
  };
  const pending = save.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="http-proxy-binding-form">
        <DialogHeader>
          <DialogTitle>{binding ? '编辑 HTTP 发布' : '新建 HTTP 发布'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {pools.length === 0 ? (
            <FormField
              id="http-proxy-domain-root"
              label="域名根"
            >
              <Select disabled>
                <SelectTrigger id="http-proxy-domain-root">
                  <SelectValue placeholder="没有可用的域名" />
                </SelectTrigger>
              </Select>
            </FormField>
          ) : (
            <>
              <FormField id="http-proxy-domain-root" label="域名根">
                <Select value={selectedPool?.id} onValueChange={edit(setPoolId)}>
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
                    onChange={(event) => edit(setPrefix)(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  />
                  <span className="shrink-0 font-mono text-sm text-muted-foreground">{suffix}</span>
                </div>
              </FormField>
            </>
          )}
          <ContainerSelect
            containerId={containerId}
            containers={containers}
            loading={containersQuery.isLoading}
            onChange={edit(setContainerId)}
          />
          <FormField id="http-proxy-port" label="目标端口">
            <Input
              id="http-proxy-port"
              type="number"
              min="1"
              max="65535"
              value={targetPort}
              onChange={(event) => edit(setTargetPort)(event.target.value)}
            />
          </FormField>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={pending || pools.length === 0}>
            {pending ? '提交中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The container picker; with nothing to pick it is disabled and says why. */
function ContainerSelect({
  containerId,
  containers,
  loading,
  onChange,
}: {
  containerId: string;
  containers: ContainerDto[];
  loading: boolean;
  onChange: (value: string) => void;
}) {
  const empty = !loading && containers.length === 0;
  return (
    <FormField
      id="http-proxy-container"
      label="容器"
      hint={empty ? (
        <>还没有容器，创建后才能发布。<Link to="/containers" className="underline">去创建容器</Link></>
      ) : undefined}
    >
      <Select value={containerId || undefined} onValueChange={onChange} disabled={loading || empty}>
        <SelectTrigger id="http-proxy-container">
          <SelectValue placeholder={loading ? '加载容器…' : empty ? '没有可用的容器' : '选择容器'} />
        </SelectTrigger>
        {!empty && (
          <SelectContent>
            {containers.map((container) => (
              <SelectItem key={container.id} value={container.id}>
                {container.name} · {container.serverName}
              </SelectItem>
            ))}
          </SelectContent>
        )}
      </Select>
    </FormField>
  );
}

export function BindingRow({
  binding,
  onEdit,
  onDelete,
}: {
  binding: HttpProxyBindingDto;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { status, warning } = userVisibleBindingState(binding);
  return (
    <TableRow className="cursor-pointer" onClick={onEdit}>
      <TableCell className="font-mono">{binding.hostname}</TableCell>
      <TableCell className="whitespace-normal">
        <Badge variant={status === 'ready' ? 'success' : status === 'warning' ? 'warning' : 'secondary'}>
          {httpProxyBindingStatusLabel(status)}
        </Badge>
        {warning ? <p className="mt-1 text-xs text-destructive">{warning}</p> : null}
      </TableCell>
      <TableCell>{binding.containerName ?? binding.containerId}</TableCell>
      <TableCell>{binding.targetPort}</TableCell>
      <BindingTrafficCells stats={binding.stats} />
      <TableCell className="font-mono">{binding.domainPool}</TableCell>
      <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onEdit}><Pencil className="h-3.5 w-3.5" />编辑</Button>
          <Button size="sm" variant="ghost-destructive" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" />删除</Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
