import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  type CreateHttpDomainPoolRequest,
  type HttpDomainPoolDto,
  type HttpProxyBindingDto,
  type PatchHttpDomainPoolRequest,
  zCreateHttpDomainPoolRequest,
  zPatchHttpDomainPoolRequest,
} from '@nyabase/common';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { SectionCard } from '../../components/layout/section-card.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table.js';
import { TechnicalId } from '../../components/refs/technical-id.js';
import { BindingTrafficCells, BindingTrafficHeads } from '../../components/http-proxy/binding-traffic.js';
import {
  httpProxyBindingStatusLabel,
  httpProxyErrorMessage,
  httpProxyWarningLabel,
} from '../../lib/http-proxy.js';
import { api } from '../../lib/api.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Switch } from '../../components/ui/switch.js';
import { Textarea } from '../../components/ui/textarea.js';
import { FormField } from '../../components/layout/form-field.js';
import { toast } from '../../hooks/use-toast.js';
import { queryKeys } from '../../lib/query-keys.js';

export function DomainPoolsCard({
  pools,
  refreshing,
  onRefresh,
  onCreate,
  onEdit,
  onDelete,
}: {
  pools: HttpDomainPoolDto[];
  refreshing: boolean;
  onRefresh: () => void;
  onCreate: () => void;
  onEdit: (pool: HttpDomainPoolDto) => void;
  onDelete: (pool: HttpDomainPoolDto) => void;
}) {
  return (
    <SectionCard
      title="域名池"
      actions={
        <>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
          <Button size="sm" onClick={onCreate}><Plus className="h-4 w-4" />新建域名池</Button>
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
                    <Button size="sm" variant="outline" onClick={() => onEdit(pool)}>
                      <Pencil className="h-3.5 w-3.5" />编辑
                    </Button>
                    <Button size="sm" variant="ghost-destructive" onClick={() => onDelete(pool)}>
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
  );
}

export function AllBindingsCard({ bindings, onDelete }: {
  bindings: HttpProxyBindingDto[];
  onDelete: (binding: HttpProxyBindingDto) => void;
}) {
  return (
    <SectionCard title="全部发布绑定" flush={bindings.length > 0}>
      {bindings.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无用户发布绑定。</p>
      ) : (
        <Table className="min-w-[1040px]">
          <TableHeader>
            <TableRow>
              <TableHead>所有者</TableHead>
              <TableHead>主机名</TableHead>
              <TableHead>容器</TableHead>
              <TableHead>端口</TableHead>
              <TableHead>HTTPS</TableHead>
              <TableHead>状态</TableHead>
              <BindingTrafficHeads />
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {bindings.map((binding) => (
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
                <BindingTrafficCells stats={binding.stats} />
                <TableCell>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" aria-label="删除发布绑定" onClick={() => onDelete(binding)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}

export function DomainPoolFormDialog({
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
    mutationFn: (body: CreateHttpDomainPoolRequest) => api.post<HttpDomainPoolDto>('/http-proxy/domain-pools', body),
    onSuccess: () => {
      toast({ title: '域名池已创建' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.httpProxy.adminDomainPools });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(httpProxyErrorMessage(mutationError)),
  });
  const patch = useMutation({
    mutationFn: (body: PatchHttpDomainPoolRequest) => api.patch<HttpDomainPoolDto>(`/http-proxy/domain-pools/${pool?.id ?? ''}`, body),
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
