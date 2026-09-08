import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { SectionCard } from '../layout/section-card.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
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

  const [serverId, setServerId] = useState('');
  const [poolId, setPoolId] = useState('');
  const [backendId, setBackendId] = useState('');
  const [cpuCores, setCpuCores] = useState('');
  const [memGib, setMemGib] = useState('');
  const [diskGib, setDiskGib] = useState('');
  const [extensionGrants, setExtensionGrants] = useState<Record<string, unknown>>({});
  const [sharedLimitGib, setSharedLimitGib] = useState('');
  const [serverExpiresAt, setServerExpiresAt] = useState('');
  const [poolExpiresAt, setPoolExpiresAt] = useState('');
  const [backendExpiresAt, setBackendExpiresAt] = useState('');
  const [editGrant, setEditGrant] = useState<ServerGrantDto | null>(null);
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

  const serverMutation = useMutation({
    mutationFn: () => {
      return api.put<ServerGrantDto>(`${prefix}/server-grants/${serverId}`, {
        cpuMillis: coresToMillis(cpuCores),
        memBytes: gibToBytes(memGib),
        diskBytes: gibToBytes(diskGib),
        extensionGrants,
        expiresAt: isoOrNull(serverExpiresAt),
      });
    },
    onSuccess: () => {
      toast({ title: '服务器授权已保存' });
      setServerId('');
      setExtensionGrants({});
      invalidate();
    },
    onError: (error) => toast({ title: '服务器授权失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const poolMutation = useMutation({
    mutationFn: (nextPoolId: string) => api.put<StoragePoolGrantDto>(`${prefix}/storage-pool-grants/${nextPoolId}`, {
      expiresAt: isoOrNull(poolExpiresAt),
    }),
    onSuccess: () => {
      toast({ title: '存储池授权已保存' });
      setPoolId('');
      invalidate();
    },
    onError: (error) => toast({ title: '存储池授权失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const backendMutation = useMutation({
    mutationFn: () => {
      const limitBytes = gibToBytes(sharedLimitGib);
      if (limitBytes === null) throw new Error('请填写额度');
      return api.put<SharedBackendGrantDto>(`${prefix}/shared-backend-grants/${backendId}`, {
        limitBytes,
        expiresAt: isoOrNull(backendExpiresAt),
      });
    },
    onSuccess: () => {
      toast({ title: '共享存储授权已保存' });
      setBackendId('');
      setSharedLimitGib('');
      invalidate();
    },
    onError: (error) => toast({ title: '共享存储授权失败', description: errorMessage(error), variant: 'destructive' }),
  });
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

  return (
    <div className="space-y-6" data-testid="canonical-grants">
      <SectionCard
        title="服务器授权"
        description="按服务器设置 CPU、内存和本地盘额度。扩展卡额度随服务器授权一起保存。"
        toolbar={(
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField
                id="grant-server"
                label="服务器"
                value={serverId}
                onChange={(value) => {
                  setServerId(value);
                  setExtensionGrants({});
                }}
                options={ungrantedServers.map((server) => [server.id, server.name])}
                placeholder={ungrantedServers.length === 0 ? '没有可添加的服务器' : '选择服务器'}
                disabled={ungrantedServers.length === 0 || serverMutation.isPending}
              />
              <ExtensionSlots
                area="grant.server"
                ctx={{
                  serverId,
                  enabledExtensions: servers.find((server) => server.id === serverId)?.enabledExtensions ?? [],
                  value: extensionGrants,
                  onChange: setExtensionGrants,
                }}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <NumberField id="grant-cpu" label="CPU（核，空=不限）" value={cpuCores} onChange={setCpuCores} />
              <NumberField id="grant-memory" label="内存（G，空=不限）" value={memGib} onChange={setMemGib} hint={gibHint(memGib)} />
              <NumberField id="grant-disk" label="磁盘（G，空=不限，不含共享卷）" value={diskGib} onChange={setDiskGib} hint={gibHint(diskGib)} />
            </div>
            <GrantExpiryInput id="grant-server-expires-at" value={serverExpiresAt} onChange={setServerExpiresAt} />
            <Button onClick={() => serverMutation.mutate()} disabled={!serverId || serverMutation.isPending}>
              {serverMutation.isPending ? '保存中...' : '保存服务器授权'}
            </Button>
          </div>
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
            : '只能授权已有服务器授权的机器上的存储池。'
        }
        toolbar={(
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField
                id="grant-pool"
                label="存储池"
                value={poolId}
                onChange={setPoolId}
                options={grantablePools.map((pool) => [
                  pool.id,
                  `${pool.displayName ?? pool.incusName} · ${serverName(pool.serverId, servers)}`,
                ])}
                placeholder={
                  grantedServerIds.size === 0
                    ? '先添加服务器授权'
                    : grantablePools.length === 0
                      ? '没有可添加的存储池'
                      : '选择存储池'
                }
                disabled={grantablePools.length === 0 || poolMutation.isPending}
              />
              <GrantExpiryInput id="grant-pool-expires-at" value={poolExpiresAt} onChange={setPoolExpiresAt} />
            </div>
            <Button
              onClick={() => poolMutation.mutate(poolId)}
              disabled={!poolId || poolMutation.isPending}
            >
              {poolMutation.isPending ? '保存中...' : '保存存储池授权'}
            </Button>
          </div>
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
        description="额度按共享后端计算，不含服务器本地盘。"
        toolbar={(
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField
                id="grant-backend"
                label="共享存储"
                value={backendId}
                onChange={setBackendId}
                options={ungrantedBackends.map((backend) => [backend.id, backend.displayName ?? backend.name])}
                placeholder={ungrantedBackends.length === 0 ? '没有可添加的共享存储' : '选择共享存储'}
                disabled={ungrantedBackends.length === 0 || backendMutation.isPending}
              />
              <NumberField id="grant-shared-limit" label="额度（G）" value={sharedLimitGib} onChange={setSharedLimitGib} hint={gibHint(sharedLimitGib)} />
            </div>
            <GrantExpiryInput id="grant-backend-expires-at" value={backendExpiresAt} onChange={setBackendExpiresAt} />
            <Button
              onClick={() => backendMutation.mutate()}
              disabled={!backendId || !sharedLimitGib || backendMutation.isPending}
            >
              {backendMutation.isPending ? '保存中...' : '保存共享存储授权'}
            </Button>
          </div>
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
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

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
          <DialogDescription>调整 CPU、内存、本地盘和扩展卡额度。存储池授权在本页另一张卡片里管理。</DialogDescription>
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
