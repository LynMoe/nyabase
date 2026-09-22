import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import {
  type EffectiveAccessDto,
  type GrantExpiryPhase,
  type GroupDto,
  type ServerDto,
  type ServerGrantDto,
  type SharedBackendDto,
  type SharedBackendGrantDto,
  type StoragePoolDto,
  type StoragePoolGrantDto,
  type UserDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { grantExpiryPhaseLabel } from '../../lib/display-labels.js';
import { formatGrantBytes, formatGrantQuotaLine } from '../../lib/grant-quota.js';
import { GIB, approxGibHint, formatGibInput, formatVcpuInput } from '../../lib/utils.js';
import { toast } from '../../hooks/use-toast.js';
import { ConfirmDialog } from '../layout/confirm-dialog.js';
import { FormField } from '../layout/form-field.js';
import { isQueryLoading } from '../layout/query-view.js';
import { SectionCard } from '../layout/section-card.js';
import { QueryErrorState, QueryLoadingState } from '../query-state.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select.js';
import { Switch } from '../ui/switch.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table.js';
import { formatExtensionGrantSummaries } from '../../extensions/registry.js';
import { ExtensionSlots } from '../../extensions/slots.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { truncateId } from '../refs/truncate-id.js';

type Subject = UserDto | GroupDto;
type SubjectKind = 'users' | 'groups';

export function CanonicalGrantPanel({ subject, kind }: { subject: Subject; kind: SubjectKind }) {
  const queryClient = useQueryClient();
  const prefix = `/admin/${kind}/${subject.id}`;
  const serversQuery = useQuery({ queryKey: queryKeys.grants.targets.servers, queryFn: () => api.get<ServerDto[]>('/admin/servers') });
  const poolsQuery = useQuery({
    queryKey: queryKeys.grants.targets.pools,
    queryFn: async () => {
      const servers = serversQuery.data ?? [];
      const rows = await Promise.all(servers.map(async (server) => api.get<StoragePoolDto[]>(`/admin/servers/${server.id}/storage-pools`)));
      return rows.flat();
    },
    enabled: serversQuery.isSuccess,
  });
  const backendsQuery = useQuery({ queryKey: queryKeys.grants.targets.backends, queryFn: () => api.get<SharedBackendDto[]>('/admin/shared-backends') });
  const serverGrantsQuery = useQuery({ queryKey: queryKeys.grants.subjectList(kind, subject.id, 'servers'), queryFn: () => api.get<ServerGrantDto[]>(`${prefix}/server-grants`) });
  const poolGrantsQuery = useQuery({ queryKey: queryKeys.grants.subjectList(kind, subject.id, 'pools'), queryFn: () => api.get<StoragePoolGrantDto[]>(`${prefix}/storage-pool-grants`) });
  const backendGrantsQuery = useQuery({ queryKey: queryKeys.grants.subjectList(kind, subject.id, 'backends'), queryFn: () => api.get<SharedBackendGrantDto[]>(`${prefix}/shared-backend-grants`) });
  const effectiveAccessQuery = useQuery({
    queryKey: queryKeys.grants.subjectList(kind, subject.id, 'effective-access'),
    queryFn: () => api.get<EffectiveAccessDto>(`${prefix}/effective-access`),
    enabled: kind === 'users',
  });

  const [createKind, setCreateKind] = useState<'server' | 'pool' | 'backend' | null>(null);
  const [editGrant, setEditGrant] = useState<ServerGrantDto | null>(null);
  const [editPoolGrant, setEditPoolGrant] = useState<StoragePoolGrantDto | null>(null);
  const [editBackendGrant, setEditBackendGrant] = useState<SharedBackendGrantDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    resource: 'server-grants' | 'storage-pool-grants' | 'shared-backend-grants';
    id: string;
    label: string;
  } | null>(null);

  const servers = serversQuery.data ?? [];
  const pools = poolsQuery.data ?? [];
  const backends = backendsQuery.data ?? [];
  const serverGrants = serverGrantsQuery.data ?? [];
  const poolGrants = poolGrantsQuery.data ?? [];
  const backendGrants = backendGrantsQuery.data ?? [];
  const grantedServerIds = new Set(serverGrants.map((row) => row.serverId));
  const ungrantedServers = servers.filter((server) => !grantedServerIds.has(server.id));
  const grantablePools = pools.filter((pool) => (
    pool.registered
    && grantedServerIds.has(pool.serverId)
    && !poolGrants.some((row) => row.poolId === pool.id)
  ));
  const ungrantedBackends = backends.filter((backend) => (
    !backendGrants.some((row) => row.sharedBackendId === backend.id)
  ));
  const orphanPoolGrants = poolGrants.filter((row) => {
    const pool = pools.find((item) => item.id === row.poolId);
    return !pool || !grantedServerIds.has(pool.serverId);
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.grants.subject(kind, subject.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.meAccess });
  };

  const remove = useMutation({
    mutationFn: ({ resource, id }: { resource: 'server-grants' | 'storage-pool-grants' | 'shared-backend-grants'; id: string }) =>
      api.delete<void>(`${prefix}/${resource}/${id}`),
    onSuccess: () => {
      toast({ title: '授权已删除' });
      setDeleteTarget(null);
      invalidate();
    },
    onError: (error) => toast({ title: '删除授权失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const closeCreate = () => setCreateKind(null);
  const grantLists = [serverGrantsQuery, poolGrantsQuery, backendGrantsQuery];
  if (grantLists.some(isQueryLoading)) {
    return (
      <div data-testid="canonical-grants">
        <QueryLoadingState label="加载授权..." />
      </div>
    );
  }
  const failedList = grantLists.find((query) => query.isError && query.data === undefined);
  if (failedList) {
    return (
      <div data-testid="canonical-grants">
        <QueryErrorState
          error={failedList.error}
          resourceName="授权"
          onRetry={() => { void failedList.refetch(); }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="canonical-grants">
      <SectionCard
        title="服务器授权"
        actions={(
          <Button size="sm" onClick={() => setCreateKind('server')} data-testid="grant-add-server">
            <Plus className="h-4 w-4" />授权
          </Button>
        )}
        flush={serverGrants.length > 0}
        testId="grant-servers"
      >
        {serverGrants.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无服务器授权。</p>
        ) : (
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>服务器</TableHead>
                <TableHead>额度</TableHead>
                <TableHead>到期</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {serverGrants.map((grant) => {
                const server = servers.find((item) => item.id === grant.serverId);
                const quotaLine = formatGrantQuotaLine(grant, formatExtensionGrantSummaries(grant.extensionGrants));
                const phase = expiryPhase(
                  grant.expiresAt,
                  effectiveAccessQuery.data?.servers.find((item) => item.serverId === grant.serverId)?.accessPhase,
                );
                return (
                  <TableRow key={grant.id}>
                    <TableCell className="whitespace-normal">
                      <ResourceRef kind="server" id={grant.serverId} name={server?.name} />
                    </TableCell>
                    <TableCell className="whitespace-normal">{quotaLine}</TableCell>
                    <TableCell>{expiryLabel(grant.expiresAt)}</TableCell>
                    <TableCell>
                      <PhaseBadge phase={phase} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => setEditGrant(grant)}>编辑</Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteTarget({
                            resource: 'server-grants',
                            id: grant.serverId,
                            label: `${server?.name ?? truncateId(grant.serverId)} · ${quotaLine} · 到期 ${expiryLabel(grant.expiresAt)}`,
                          })}
                        >
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <SectionCard
        title="存储池授权"
        description={
          orphanPoolGrants.length > 0
            ? '只能授权已有服务器授权的机器上的存储池。存储池（无服务器授权）仍会列在表中，需先补上对应服务器授权。'
            : undefined
        }
        actions={(
          <Button size="sm" onClick={() => setCreateKind('pool')} data-testid="grant-add-pool">
            <Plus className="h-4 w-4" />授权
          </Button>
        )}
        flush={poolGrants.length > 0}
        testId="grant-pools"
      >
        {poolGrants.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无存储池授权。</p>
        ) : (
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>存储池</TableHead>
                <TableHead>服务器</TableHead>
                <TableHead>到期</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {poolGrants.map((grant) => {
                const pool = pools.find((item) => item.id === grant.poolId);
                const orphan = !pool || !grantedServerIds.has(pool.serverId);
                const phase = expiryPhase(grant.expiresAt);
                return (
                  <TableRow key={grant.id}>
                    <TableCell className="whitespace-normal">
                      <div className="space-y-1">
                        <ResourceRef kind="pool" id={grant.poolId} name={pool ? (pool.displayName ?? pool.incusName) : undefined} />
                        {orphan ? (
                          <Badge variant="warning">无服务器授权</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {pool ? (
                        <ResourceRef kind="server" id={pool.serverId} name={serverName(pool.serverId, servers)} />
                      ) : '—'}
                    </TableCell>
                    <TableCell>{expiryLabel(grant.expiresAt)}</TableCell>
                    <TableCell>
                      <PhaseBadge phase={phase} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => setEditPoolGrant(grant)}>编辑</Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteTarget({
                            resource: 'storage-pool-grants',
                            id: grant.poolId,
                            label: `${poolName(grant.poolId, pools, servers)} · 到期 ${expiryLabel(grant.expiresAt)}`,
                          })}
                        >
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <SectionCard
        title="共享存储授权"
        actions={(
          <Button size="sm" onClick={() => setCreateKind('backend')} data-testid="grant-add-backend">
            <Plus className="h-4 w-4" />授权
          </Button>
        )}
        flush={backendGrants.length > 0}
        testId="grant-backends"
      >
        {backendGrants.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无共享存储授权。</p>
        ) : (
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>共享存储</TableHead>
                <TableHead>额度</TableHead>
                <TableHead>到期</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backendGrants.map((grant) => {
                const phase = expiryPhase(grant.expiresAt);
                return (
                  <TableRow key={grant.id}>
                    <TableCell className="whitespace-normal">
                      <ResourceRef
                        kind="shared-backend"
                        id={grant.sharedBackendId}
                        name={backendDisplayName(grant.sharedBackendId, backends)}
                      />
                    </TableCell>
                    <TableCell>{formatGrantBytes(grant.limitBytes)}</TableCell>
                    <TableCell>{expiryLabel(grant.expiresAt)}</TableCell>
                    <TableCell>
                      <PhaseBadge phase={phase} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => setEditBackendGrant(grant)}>编辑</Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteTarget({
                            resource: 'shared-backend-grants',
                            id: grant.sharedBackendId,
                            label: `${backendName(grant.sharedBackendId, backends)} · ${formatGrantBytes(grant.limitBytes)} · 到期 ${expiryLabel(grant.expiresAt)}`,
                          })}
                        >
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      {createKind === 'server' ? (
        <ServerGrantCreateDialog
          prefix={prefix}
          servers={ungrantedServers}
          loading={serversQuery.isLoading}
          error={serversQuery.isError}
          onRetry={() => { void serversQuery.refetch(); }}
          onSaved={() => {
            closeCreate();
            invalidate();
          }}
          onOpenChange={(open) => { if (!open) closeCreate(); }}
        />
      ) : null}

      {createKind === 'pool' ? (
        <PoolGrantCreateDialog
          prefix={prefix}
          pools={grantablePools}
          servers={servers}
          hasServerGrants={grantedServerIds.size > 0}
          loading={serversQuery.isLoading || poolsQuery.isLoading}
          error={serversQuery.isError || poolsQuery.isError}
          onRetry={() => {
            void serversQuery.refetch();
            void poolsQuery.refetch();
          }}
          onSaved={() => {
            closeCreate();
            invalidate();
          }}
          onOpenChange={(open) => { if (!open) closeCreate(); }}
        />
      ) : null}

      {createKind === 'backend' ? (
        <BackendGrantCreateDialog
          prefix={prefix}
          backends={ungrantedBackends}
          loading={backendsQuery.isLoading}
          error={backendsQuery.isError}
          onRetry={() => { void backendsQuery.refetch(); }}
          onSaved={() => {
            closeCreate();
            invalidate();
          }}
          onOpenChange={(open) => { if (!open) closeCreate(); }}
        />
      ) : null}

      {editGrant ? (
        <ServerGrantEditDialog
          grant={editGrant}
          server={servers.find((item) => item.id === editGrant.serverId)}
          prefix={prefix}
          onSaved={() => {
            setEditGrant(null);
            invalidate();
          }}
          onOpenChange={(open) => { if (!open) setEditGrant(null); }}
        />
      ) : null}

      {editPoolGrant ? (
        <PoolGrantEditDialog
          grant={editPoolGrant}
          title={poolName(editPoolGrant.poolId, pools, servers)}
          prefix={prefix}
          onSaved={() => {
            setEditPoolGrant(null);
            invalidate();
          }}
          onOpenChange={(open) => { if (!open) setEditPoolGrant(null); }}
        />
      ) : null}

      {editBackendGrant ? (
        <BackendGrantEditDialog
          grant={editBackendGrant}
          title={backendName(editBackendGrant.sharedBackendId, backends)}
          prefix={prefix}
          onSaved={() => {
            setEditBackendGrant(null);
            invalidate();
          }}
          onOpenChange={(open) => { if (!open) setEditBackendGrant(null); }}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除授权？"
        description={`将删除「${deleteTarget?.label}」。删除后该主体将立即失去对应资源访问权（若仍在宽限期内，以服务端状态为准）。`}
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={remove.isPending}
        onConfirm={() => {
          if (deleteTarget) remove.mutate({ resource: deleteTarget.resource, id: deleteTarget.id });
        }}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      />
    </div>
  );
}

function ChoiceUnavailable({
  loading,
  error,
  onRetry,
  empty,
}: {
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  empty: string;
}) {
  if (loading) return <QueryLoadingState label="加载可选项..." />;
  if (error) {
    return (
      <p className="text-sm text-destructive">
        无法加载可选项。
        {onRetry ? (
          <button type="button" className="ml-2 underline" onClick={onRetry}>重试</button>
        ) : null}
      </p>
    );
  }
  return <p className="text-sm text-muted-foreground">{empty}</p>;
}

function ServerGrantCreateDialog({
  prefix,
  servers,
  loading,
  error,
  onRetry,
  onSaved,
  onOpenChange,
}: {
  prefix: string;
  servers: ServerDto[];
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  onSaved: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [serverId, setServerId] = useState('');
  const [cpuCores, setCpuCores] = useState('');
  const [memGib, setMemGib] = useState('');
  const [diskGib, setDiskGib] = useState('');
  const [extensionGrants, setExtensionGrants] = useState<Record<string, unknown>>({});
  const [expiresAt, setExpiresAt] = useState('');
  const canChoose = !loading && !error && servers.length > 0;

  const save = useMutation({
    mutationFn: () => api.put<ServerGrantDto>(`${prefix}/server-grants/${serverId}`, {
      cpuMillis: coresToMillis(cpuCores),
      memBytes: gibToBytes(memGib),
      diskBytes: gibToBytes(diskGib),
      extensionGrants,
      expiresAt: isoOrNull(expiresAt),
    }),
    onSuccess: () => {
      toast({ title: '服务器授权已保存' });
      onSaved();
    },
    onError: (saveError) => toast({ title: '服务器授权失败', description: errorMessage(saveError), variant: 'destructive' }),
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>添加服务器授权</DialogTitle>
        </DialogHeader>
        {canChoose ? (
          <div className="space-y-3">
            <SelectField
              id="grant-server"
              label="服务器"
              value={serverId}
              onChange={(value) => {
                setServerId(value);
                setExtensionGrants({});
              }}
              options={servers.map((server) => [server.id, server.name])}
              placeholder="选择服务器"
              disabled={save.isPending}
            />
            {serverId ? (
              <ExtensionSlots
                area="grant.server"
                ctx={{
                  serverId,
                  enabledExtensions: servers.find((server) => server.id === serverId)?.enabledExtensions ?? [],
                  value: extensionGrants,
                  onChange: setExtensionGrants,
                }}
              />
            ) : null}
            <div className="grid gap-3 sm:grid-cols-3">
              <NumberField id="grant-cpu" label="CPU（核，空=不限）" value={cpuCores} onChange={setCpuCores} />
              <NumberField id="grant-memory" label="内存（G，空=不限）" value={memGib} onChange={setMemGib} hint={gibHint(memGib)} />
              <NumberField id="grant-disk" label="磁盘（G，空=不限，不含共享卷）" value={diskGib} onChange={setDiskGib} hint={gibHint(diskGib)} />
            </div>
            <GrantExpiryInput id="grant-server-expires-at" value={expiresAt} onChange={setExpiresAt} />
          </div>
        ) : (
          <ChoiceUnavailable loading={loading} error={error} onRetry={onRetry} empty="没有可添加的服务器。" />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{canChoose ? '取消' : '关闭'}</Button>
          {canChoose ? (
            <Button onClick={() => save.mutate()} disabled={!serverId || save.isPending}>
              {save.isPending ? '保存中...' : '保存'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PoolGrantCreateDialog({
  prefix,
  pools,
  servers,
  hasServerGrants,
  loading,
  error,
  onRetry,
  onSaved,
  onOpenChange,
}: {
  prefix: string;
  pools: StoragePoolDto[];
  servers: ServerDto[];
  hasServerGrants: boolean;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  onSaved: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [poolId, setPoolId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const canChoose = !loading && !error && pools.length > 0;

  const save = useMutation({
    mutationFn: () => api.put<StoragePoolGrantDto>(`${prefix}/storage-pool-grants/${poolId}`, {
      expiresAt: isoOrNull(expiresAt),
    }),
    onSuccess: () => {
      toast({ title: '存储池授权已保存' });
      onSaved();
    },
    onError: (saveError) => toast({ title: '存储池授权失败', description: errorMessage(saveError), variant: 'destructive' }),
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加存储池授权</DialogTitle>
        </DialogHeader>
        {canChoose ? (
          <div className="space-y-3">
            <SelectField
              id="grant-pool"
              label="存储池"
              value={poolId}
              onChange={setPoolId}
              options={pools.map((pool) => [
                pool.id,
                `${pool.displayName ?? pool.incusName} · ${serverName(pool.serverId, servers)}`,
              ])}
              placeholder="选择存储池"
              disabled={save.isPending}
            />
            <GrantExpiryInput id="grant-pool-expires-at" value={expiresAt} onChange={setExpiresAt} />
          </div>
        ) : (
          <ChoiceUnavailable
            loading={loading}
            error={error}
            onRetry={onRetry}
            empty={hasServerGrants ? '没有可添加的存储池。' : '请先添加服务器授权。'}
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{canChoose ? '取消' : '关闭'}</Button>
          {canChoose ? (
            <Button onClick={() => save.mutate()} disabled={!poolId || save.isPending}>
              {save.isPending ? '保存中...' : '保存'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BackendGrantCreateDialog({
  prefix,
  backends,
  loading,
  error,
  onRetry,
  onSaved,
  onOpenChange,
}: {
  prefix: string;
  backends: SharedBackendDto[];
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  onSaved: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [backendId, setBackendId] = useState('');
  const [sharedLimitGib, setSharedLimitGib] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const canChoose = !loading && !error && backends.length > 0;

  const save = useMutation({
    mutationFn: () => {
      const limitBytes = gibToBytes(sharedLimitGib);
      if (limitBytes === null) throw new Error('请填写额度');
      return api.put<SharedBackendGrantDto>(`${prefix}/shared-backend-grants/${backendId}`, {
        limitBytes,
        expiresAt: isoOrNull(expiresAt),
      });
    },
    onSuccess: () => {
      toast({ title: '共享存储授权已保存' });
      onSaved();
    },
    onError: (saveError) => toast({ title: '共享存储授权失败', description: errorMessage(saveError), variant: 'destructive' }),
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加共享存储授权</DialogTitle>
        </DialogHeader>
        {canChoose ? (
          <div className="space-y-3">
            <SelectField
              id="grant-backend"
              label="共享存储"
              value={backendId}
              onChange={setBackendId}
              options={backends.map((backend) => [backend.id, backend.displayName ?? backend.name])}
              placeholder="选择共享存储"
              disabled={save.isPending}
            />
            <NumberField id="grant-shared-limit" label="额度（G）" value={sharedLimitGib} onChange={setSharedLimitGib} hint={gibHint(sharedLimitGib)} />
            <GrantExpiryInput id="grant-backend-expires-at" value={expiresAt} onChange={setExpiresAt} />
          </div>
        ) : (
          <ChoiceUnavailable loading={loading} error={error} onRetry={onRetry} empty="没有可添加的共享存储。" />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{canChoose ? '取消' : '关闭'}</Button>
          {canChoose ? (
            <Button onClick={() => save.mutate()} disabled={!backendId || !sharedLimitGib || save.isPending}>
              {save.isPending ? '保存中...' : '保存'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PoolGrantEditDialog({
  grant,
  title,
  prefix,
  onSaved,
  onOpenChange,
}: {
  grant: StoragePoolGrantDto;
  title: string;
  prefix: string;
  onSaved: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [expiresAt, setExpiresAt] = useState(() => grant.expiresAt ? toDatetimeLocalValue(new Date(grant.expiresAt)) : '');
  const save = useMutation({
    mutationFn: () => api.put<StoragePoolGrantDto>(`${prefix}/storage-pool-grants/${grant.poolId}`, {
      expiresAt: isoOrNull(expiresAt),
    }),
    onSuccess: () => {
      toast({ title: '存储池授权已保存' });
      onSaved();
    },
    onError: (saveError) => toast({ title: '存储池授权失败', description: errorMessage(saveError), variant: 'destructive' }),
  });
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑「{title}」的存储池授权</DialogTitle>
        </DialogHeader>
        <GrantExpiryInput id={`grant-pool-expires-at-${grant.poolId}`} value={expiresAt} onChange={setExpiresAt} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BackendGrantEditDialog({
  grant,
  title,
  prefix,
  onSaved,
  onOpenChange,
}: {
  grant: SharedBackendGrantDto;
  title: string;
  prefix: string;
  onSaved: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [sharedLimitGib, setSharedLimitGib] = useState(() => formatGibInput(grant.limitBytes));
  const [expiresAt, setExpiresAt] = useState(() => grant.expiresAt ? toDatetimeLocalValue(new Date(grant.expiresAt)) : '');
  const save = useMutation({
    mutationFn: () => {
      const limitBytes = gibToBytes(sharedLimitGib);
      if (limitBytes === null) throw new Error('请填写额度');
      return api.put<SharedBackendGrantDto>(`${prefix}/shared-backend-grants/${grant.sharedBackendId}`, {
        limitBytes,
        expiresAt: isoOrNull(expiresAt),
      });
    },
    onSuccess: () => {
      toast({ title: '共享存储授权已保存' });
      onSaved();
    },
    onError: (saveError) => toast({ title: '共享存储授权失败', description: errorMessage(saveError), variant: 'destructive' }),
  });
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑「{title}」的共享存储授权</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <NumberField
            id={`grant-shared-limit-${grant.sharedBackendId}`}
            label="额度（G）"
            value={sharedLimitGib}
            onChange={setSharedLimitGib}
            hint={gibHint(sharedLimitGib)}
          />
          <GrantExpiryInput id={`grant-backend-expires-at-${grant.sharedBackendId}`} value={expiresAt} onChange={setExpiresAt} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => save.mutate()} disabled={!sharedLimitGib || save.isPending}>
            {save.isPending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ServerGrantEditDialog({
  grant,
  server,
  prefix,
  onSaved,
  onOpenChange,
}: {
  grant: ServerGrantDto;
  server: ServerDto | undefined;
  prefix: string;
  onSaved: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [cpuCores, setCpuCores] = useState(() => grant.cpuMillis == null ? '' : formatVcpuInput(grant.cpuMillis));
  const [memGib, setMemGib] = useState(() => grant.memBytes == null ? '' : formatGibInput(grant.memBytes));
  const [diskGib, setDiskGib] = useState(() => grant.diskBytes == null ? '' : formatGibInput(grant.diskBytes));
  const [extensionGrants, setExtensionGrants] = useState<Record<string, unknown>>(() => ({ ...grant.extensionGrants }));
  const [expiresAt, setExpiresAt] = useState(() => grant.expiresAt ? toDatetimeLocalValue(new Date(grant.expiresAt)) : '');
  const title = server?.name ?? truncateId(grant.serverId);

  const save = useMutation({
    mutationFn: () => api.put<ServerGrantDto>(`${prefix}/server-grants/${grant.serverId}`, {
      cpuMillis: coresToMillis(cpuCores),
      memBytes: gibToBytes(memGib),
      diskBytes: gibToBytes(diskGib),
      extensionGrants,
      expiresAt: isoOrNull(expiresAt),
    }),
    onSuccess: () => {
      toast({ title: '服务器授权已保存' });
      onSaved();
    },
    onError: (error) => toast({ title: '服务器授权失败', description: errorMessage(error), variant: 'destructive' }),
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>编辑「{title}」的服务器授权</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField id={`grant-cpu-${grant.serverId}`} label="CPU（核，空=不限）" value={cpuCores} onChange={setCpuCores} />
            <NumberField id={`grant-memory-${grant.serverId}`} label="内存（G，空=不限）" value={memGib} onChange={setMemGib} hint={gibHint(memGib)} />
            <NumberField id={`grant-disk-${grant.serverId}`} label="磁盘（G，空=不限，不含共享卷）" value={diskGib} onChange={setDiskGib} hint={gibHint(diskGib)} />
          </div>
          <ExtensionSlots
            area="grant.server"
            ctx={{
              serverId: grant.serverId,
              enabledExtensions: server?.enabledExtensions ?? [],
              value: extensionGrants,
              onChange: setExtensionGrants,
            }}
          />
          <GrantExpiryInput id={`grant-server-expires-at-${grant.serverId}`} value={expiresAt} onChange={setExpiresAt} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PhaseBadge({ phase }: { phase: GrantExpiryPhase }) {
  return (
    <Badge variant={phase === 'lost' ? 'destructive' : phase === 'grace' ? 'warning' : 'outline'}>
      {grantExpiryPhaseLabel(phase)}
    </Badge>
  );
}

function GrantExpiryInput({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  const enabled = value.length > 0;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">到期时间</p>
          <p className="text-xs text-muted-foreground">{enabled ? expirySummary(value) : '不设期限'}</p>
        </div>
        <Switch
          id={id}
          checked={enabled}
          onCheckedChange={(checked) => onChange(checked ? defaultExpiryLocal() : '')}
          aria-label="设置到期时间"
        />
      </div>
      {enabled && (
        <FormField id={`${id}-at`} label="具体时间（本地时区）">
          <Input
            id={`${id}-at`}
            type="datetime-local"
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </FormField>
      )}
    </div>
  );
}

export function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultExpiryLocal(): string {
  return toDatetimeLocalValue(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
}

function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  disabled = false,
  placeholder = '请选择',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <FormField id={id} label={label}>
      <Select key={value || 'empty'} value={value || undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map(([optionValue, optionLabel]) => (
            <SelectItem key={optionValue} value={optionValue}>{optionLabel}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  return (
    <FormField id={id} label={label} hint={hint}>
      <Input id={id} type="number" min="0" step="any" value={value} onChange={(event) => onChange(event.target.value)} />
    </FormField>
  );
}

function coresToMillis(value: string): number | null {
  if (!value.trim()) return null;
  const cores = Number(value);
  if (!Number.isFinite(cores) || cores < 0) return null;
  return Math.round(cores * 1000);
}

function gibToBytes(value: string): number | null {
  if (!value.trim()) return null;
  const gib = Number(value);
  if (!Number.isFinite(gib) || gib < 0) return null;
  return Math.round(gib * GIB);
}

function gibHint(value: string): string | undefined {
  const bytes = gibToBytes(value);
  if (bytes === null) return undefined;
  return approxGibHint(bytes);
}

function isoOrNull(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function serverName(id: string, servers: ServerDto[]): string {
  return servers.find((server) => server.id === id)?.name ?? truncateId(id);
}

function poolFullName(id: string, pools: StoragePoolDto[], servers: ServerDto[]): string | undefined {
  const pool = pools.find((item) => item.id === id);
  if (!pool) return undefined;
  return `${pool.displayName ?? pool.incusName} · ${serverName(pool.serverId, servers)}`;
}

function poolName(id: string, pools: StoragePoolDto[], servers: ServerDto[]): string {
  return poolFullName(id, pools, servers) ?? truncateId(id);
}

function backendDisplayName(id: string, backends: SharedBackendDto[]): string | undefined {
  const backend = backends.find((item) => item.id === id);
  return backend ? (backend.displayName ?? backend.name) : undefined;
}

function backendName(id: string, backends: SharedBackendDto[]): string {
  return backendDisplayName(id, backends) ?? truncateId(id);
}

function expiryPhase(value: string | null, effective?: GrantExpiryPhase): GrantExpiryPhase {
  if (effective) return effective;
  if (!value) return 'live';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp) || timestamp > Date.now()) return 'live';
  return 'lost';
}

function expiryLabel(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '不设期限';
}

function expirySummary(value: string): string {
  return value ? expiryLabel(isoOrNull(value)) : '不设期限';
}
