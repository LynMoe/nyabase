import { useState, type ReactNode } from 'react';
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
import { SelectField } from '../layout/select-field.js';
import { useActionMutation } from '../../hooks/use-action-mutation.js';
import { isQueryLoading } from '../layout/query-view.js';
import { SectionCard } from '../layout/section-card.js';
import { QueryErrorState, QueryLoadingState } from '../query-state.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Hint } from '../ui/hint.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
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

  const serverBlocked = !serversQuery.isSuccess
    ? null
    : servers.length === 0
      ? '还没有服务器，请先在“服务器”页添加。'
      : ungrantedServers.length === 0 ? '所有服务器都已授权。' : null;
  const poolBlocked = serverGrants.length === 0
    ? '请先添加服务器授权。'
    : poolsQuery.isSuccess && grantablePools.length === 0
      ? '已授权服务器上没有其他可授权的存储池。'
      : null;
  const backendBlocked = !backendsQuery.isSuccess
    ? null
    : backends.length === 0
      ? '还没有登记共享存储。'
      : ungrantedBackends.length === 0 ? '所有共享存储都已授权。' : null;

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
          <AddGrantButton blocked={serverBlocked} onClick={() => setCreateKind('server')} testId="grant-add-server" />
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
          <AddGrantButton blocked={poolBlocked} onClick={() => setCreateKind('pool')} testId="grant-add-pool" />
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
          <AddGrantButton blocked={backendBlocked} onClick={() => setCreateKind('backend')} testId="grant-add-backend" />
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
        <ServerGrantDialog
          prefix={prefix}
          servers={ungrantedServers}
          choice={{
            loading: serversQuery.isLoading,
            error: serversQuery.isError,
            onRetry: () => { void serversQuery.refetch(); },
          }}
          onSaved={() => {
            closeCreate();
            invalidate();
          }}
          onOpenChange={(open) => { if (!open) closeCreate(); }}
        />
      ) : null}

      {createKind === 'pool' ? (
        <PoolGrantDialog
          prefix={prefix}
          pools={grantablePools}
          servers={servers}
          hasServerGrants={grantedServerIds.size > 0}
          choice={{
            loading: serversQuery.isLoading || poolsQuery.isLoading,
            error: serversQuery.isError || poolsQuery.isError,
            onRetry: () => {
              void serversQuery.refetch();
              void poolsQuery.refetch();
            },
          }}
          onSaved={() => {
            closeCreate();
            invalidate();
          }}
          onOpenChange={(open) => { if (!open) closeCreate(); }}
        />
      ) : null}

      {createKind === 'backend' ? (
        <BackendGrantDialog
          prefix={prefix}
          backends={ungrantedBackends}
          choice={{
            loading: backendsQuery.isLoading,
            error: backendsQuery.isError,
            onRetry: () => { void backendsQuery.refetch(); },
          }}
          onSaved={() => {
            closeCreate();
            invalidate();
          }}
          onOpenChange={(open) => { if (!open) closeCreate(); }}
        />
      ) : null}

      {editGrant ? (
        <ServerGrantDialog
          grant={editGrant}
          servers={servers}
          prefix={prefix}
          onSaved={() => {
            setEditGrant(null);
            invalidate();
          }}
          onOpenChange={(open) => { if (!open) setEditGrant(null); }}
        />
      ) : null}

      {editPoolGrant ? (
        <PoolGrantDialog
          grant={editPoolGrant}
          title={poolName(editPoolGrant.poolId, pools, servers)}
          pools={pools}
          servers={servers}
          prefix={prefix}
          onSaved={() => {
            setEditPoolGrant(null);
            invalidate();
          }}
          onOpenChange={(open) => { if (!open) setEditPoolGrant(null); }}
        />
      ) : null}

      {editBackendGrant ? (
        <BackendGrantDialog
          grant={editBackendGrant}
          title={backendName(editBackendGrant.sharedBackendId, backends)}
          backends={backends}
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

/** "+ 授权" that says up front when there is nothing left to grant, instead of opening an empty dialog. */
function AddGrantButton({ blocked, onClick, testId }: { blocked: string | null; onClick: () => void; testId: string }) {
  return (
    <Hint content={blocked} disabled={blocked !== null}>
      <Button size="sm" onClick={onClick} disabled={blocked !== null} data-testid={testId}>
        <Plus className="h-4 w-4" />授权
      </Button>
    </Hint>
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

type GrantTarget =
  | {
    mode: 'create';
    label: string;
    placeholder: string;
    options: Array<[string, string]>;
    loading?: boolean;
    error?: boolean;
    onRetry?: () => void;
    empty: string;
  }
  | { mode: 'edit'; id: string; name: string };

/**
 * Shared shell for adding or editing one grant: choose the target (or show
 * the fixed one), fill the kind-specific fields, save with standard feedback.
 */
function GrantDialog({
  noun,
  target,
  idPrefix,
  wide = false,
  canSave = true,
  save,
  onTargetChange,
  onSaved,
  onOpenChange,
  children,
}: {
  noun: string;
  target: GrantTarget;
  idPrefix: string;
  wide?: boolean;
  canSave?: boolean;
  save: (targetId: string) => Promise<unknown>;
  onTargetChange?: (targetId: string) => void;
  onSaved: () => void;
  onOpenChange: (open: boolean) => void;
  children: (targetId: string) => ReactNode;
}) {
  const [chosen, setChosen] = useState('');
  const targetId = target.mode === 'edit' ? target.id : chosen;
  const mutation = useActionMutation({
    mutationFn: () => save(targetId),
    successTitle: `${noun}已保存`,
    errorTitle: `${noun}保存失败`,
    onSuccess: onSaved,
  });
  const ready = target.mode === 'edit'
    || (!target.loading && !target.error && target.options.length > 0);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className={wide ? 'sm:max-w-3xl' : undefined}>
        <DialogHeader>
          <DialogTitle>{target.mode === 'edit' ? `编辑「${target.name}」的${noun}` : `添加${noun}`}</DialogTitle>
        </DialogHeader>
        {ready ? (
          <div className="space-y-3">
            {target.mode === 'create' ? (
              <SelectField
                id={`${idPrefix}-target`}
                label={target.label}
                value={chosen}
                onChange={(value) => {
                  setChosen(value);
                  onTargetChange?.(value);
                }}
                options={target.options}
                placeholder={target.placeholder}
                disabled={mutation.isPending}
              />
            ) : null}
            {children(targetId)}
          </div>
        ) : target.mode === 'create' ? (
          <ChoiceUnavailable loading={target.loading} error={target.error} onRetry={target.onRetry} empty={target.empty} />
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{ready ? '取消' : '关闭'}</Button>
          {ready ? (
            <Button onClick={() => mutation.mutate()} disabled={!targetId || !canSave || mutation.isPending}>
              {mutation.isPending ? '保存中...' : '保存'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ChoiceState = { loading?: boolean; error?: boolean; onRetry?: () => void };

function initialExpiry(expiresAt: string | null | undefined): string {
  return expiresAt ? toDatetimeLocalValue(new Date(expiresAt)) : '';
}

function ServerGrantDialog({
  prefix,
  grant,
  servers,
  choice,
  onSaved,
  onOpenChange,
}: {
  prefix: string;
  /** Present when editing; absent when adding. */
  grant?: ServerGrantDto;
  servers: ServerDto[];
  choice?: ChoiceState;
  onSaved: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [cpuCores, setCpuCores] = useState(() => grant?.cpuMillis == null ? '' : formatVcpuInput(grant.cpuMillis));
  const [memGib, setMemGib] = useState(() => grant?.memBytes == null ? '' : formatGibInput(grant.memBytes));
  const [diskGib, setDiskGib] = useState(() => grant?.diskBytes == null ? '' : formatGibInput(grant.diskBytes));
  const [extensionGrants, setExtensionGrants] = useState<Record<string, unknown>>(() => ({ ...(grant?.extensionGrants ?? {}) }));
  const [expiresAt, setExpiresAt] = useState(() => initialExpiry(grant?.expiresAt));
  const idPrefix = grant ? `grant-${grant.serverId}` : 'grant';

  return (
    <GrantDialog
      noun="服务器授权"
      idPrefix={idPrefix}
      wide
      target={grant
        ? { mode: 'edit', id: grant.serverId, name: servers.find((item) => item.id === grant.serverId)?.name ?? truncateId(grant.serverId) }
        : {
          mode: 'create',
          label: '服务器',
          placeholder: '选择服务器',
          options: servers.map((server) => [server.id, server.name]),
          empty: '没有可添加的服务器。',
          ...choice,
        }}
      onTargetChange={() => setExtensionGrants({})}
      save={(serverId) => api.put<ServerGrantDto>(`${prefix}/server-grants/${serverId}`, {
        cpuMillis: coresToMillis(cpuCores),
        memBytes: gibToBytes(memGib),
        diskBytes: gibToBytes(diskGib),
        extensionGrants,
        expiresAt: isoOrNull(expiresAt),
      })}
      onSaved={onSaved}
      onOpenChange={onOpenChange}
    >
      {(serverId) => (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField id={`${idPrefix}-cpu`} label="CPU（核，留空为不限）" value={cpuCores} onChange={setCpuCores} />
            <NumberField id={`${idPrefix}-memory`} label="内存（GiB，留空为不限）" value={memGib} onChange={setMemGib} hint={gibHint(memGib)} />
            <NumberField id={`${idPrefix}-disk`} label="磁盘（GiB，留空为不限，不含共享卷）" value={diskGib} onChange={setDiskGib} hint={gibHint(diskGib)} />
          </div>
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
          <GrantExpiryInput id={`${idPrefix}-expires-at`} value={expiresAt} onChange={setExpiresAt} />
        </>
      )}
    </GrantDialog>
  );
}

function PoolGrantDialog({
  prefix,
  grant,
  title,
  pools,
  servers,
  hasServerGrants,
  choice,
  onSaved,
  onOpenChange,
}: {
  prefix: string;
  grant?: StoragePoolGrantDto;
  title?: string;
  pools: StoragePoolDto[];
  servers: ServerDto[];
  hasServerGrants?: boolean;
  choice?: ChoiceState;
  onSaved: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [expiresAt, setExpiresAt] = useState(() => initialExpiry(grant?.expiresAt));
  const idPrefix = grant ? `grant-pool-${grant.poolId}` : 'grant-pool';
  return (
    <GrantDialog
      noun="存储池授权"
      idPrefix={idPrefix}
      target={grant
        ? { mode: 'edit', id: grant.poolId, name: title ?? truncateId(grant.poolId) }
        : {
          mode: 'create',
          label: '存储池',
          placeholder: '选择存储池',
          options: pools.map((pool) => [
            pool.id,
            `${pool.displayName ?? pool.incusName} · ${serverName(pool.serverId, servers)}`,
          ]),
          empty: hasServerGrants ? '没有可添加的存储池。' : '请先添加服务器授权。',
          ...choice,
        }}
      save={(poolId) => api.put<StoragePoolGrantDto>(`${prefix}/storage-pool-grants/${poolId}`, {
        expiresAt: isoOrNull(expiresAt),
      })}
      onSaved={onSaved}
      onOpenChange={onOpenChange}
    >
      {() => <GrantExpiryInput id={`${idPrefix}-expires-at`} value={expiresAt} onChange={setExpiresAt} />}
    </GrantDialog>
  );
}

function BackendGrantDialog({
  prefix,
  grant,
  title,
  backends,
  choice,
  onSaved,
  onOpenChange,
}: {
  prefix: string;
  grant?: SharedBackendGrantDto;
  title?: string;
  backends: SharedBackendDto[];
  choice?: ChoiceState;
  onSaved: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [sharedLimitGib, setSharedLimitGib] = useState(() => (grant ? formatGibInput(grant.limitBytes) : ''));
  const [expiresAt, setExpiresAt] = useState(() => initialExpiry(grant?.expiresAt));
  const idPrefix = grant ? `grant-backend-${grant.sharedBackendId}` : 'grant-backend';
  return (
    <GrantDialog
      noun="共享存储授权"
      idPrefix={idPrefix}
      canSave={Boolean(sharedLimitGib)}
      target={grant
        ? { mode: 'edit', id: grant.sharedBackendId, name: title ?? truncateId(grant.sharedBackendId) }
        : {
          mode: 'create',
          label: '共享存储',
          placeholder: '选择共享存储',
          options: backends.map((backend) => [backend.id, backend.displayName ?? backend.name]),
          empty: '没有可添加的共享存储。',
          ...choice,
        }}
      save={(backendId) => {
        const limitBytes = gibToBytes(sharedLimitGib);
        if (limitBytes === null) return Promise.reject(new Error('请填写额度'));
        return api.put<SharedBackendGrantDto>(`${prefix}/shared-backend-grants/${backendId}`, {
          limitBytes,
          expiresAt: isoOrNull(expiresAt),
        });
      }}
      onSaved={onSaved}
      onOpenChange={onOpenChange}
    >
      {() => (
        <>
          <NumberField id={`${idPrefix}-limit`} label="额度（GiB）" value={sharedLimitGib} onChange={setSharedLimitGib} hint={gibHint(sharedLimitGib)} />
          <GrantExpiryInput id={`${idPrefix}-expires-at`} value={expiresAt} onChange={setExpiresAt} />
        </>
      )}
    </GrantDialog>
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
