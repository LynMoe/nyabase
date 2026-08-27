import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GpuGrantMode,
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
import { grantExpiryPhaseLabel } from '../../lib/display-labels.js';
import { formatCpu, approxGibHint } from '../../lib/utils.js';
import { toast } from '../../hooks/use-toast.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import {
  GpuPicker,
  type GpuPickerMode,
  resolveGpuPciAddresses,
  useServerGpus,
} from '../containers/gpu-picker.js';

type Subject = UserDto | GroupDto;
type SubjectKind = 'users' | 'groups';

const GIB = 1024 ** 3;

export function CanonicalGrantPanel({ subject, kind }: { subject: Subject; kind: SubjectKind }) {
  const queryClient = useQueryClient();
  const prefix = `/admin/${kind}/${subject.id}`;
  const serversQuery = useQuery({ queryKey: ['grant-targets', 'servers'], queryFn: () => api.get<ServerDto[]>('/admin/servers') });
  const poolsQuery = useQuery({
    queryKey: ['grant-targets', 'pools'],
    queryFn: async () => {
      const servers = serversQuery.data ?? [];
      const rows = await Promise.all(servers.map(async (server) => api.get<StoragePoolDto[]>(`/admin/servers/${server.id}/storage-pools`)));
      return rows.flat();
    },
    enabled: serversQuery.isSuccess,
  });
  const backendsQuery = useQuery({ queryKey: ['grant-targets', 'backends'], queryFn: () => api.get<SharedBackendDto[]>('/admin/shared-backends') });
  const serverGrantsQuery = useQuery({ queryKey: ['grants', kind, subject.id, 'servers'], queryFn: () => api.get<ServerGrantDto[]>(`${prefix}/server-grants`) });
  const poolGrantsQuery = useQuery({ queryKey: ['grants', kind, subject.id, 'pools'], queryFn: () => api.get<StoragePoolGrantDto[]>(`${prefix}/storage-pool-grants`) });
  const backendGrantsQuery = useQuery({ queryKey: ['grants', kind, subject.id, 'backends'], queryFn: () => api.get<SharedBackendGrantDto[]>(`${prefix}/shared-backend-grants`) });
  const effectiveAccessQuery = useQuery({
    queryKey: ['grants', kind, subject.id, 'effective-access'],
    queryFn: () => api.get<EffectiveAccessDto>(`${prefix}/effective-access`),
    enabled: kind === 'users',
  });

  const [serverId, setServerId] = useState('');
  const [poolId, setPoolId] = useState('');
  const [backendId, setBackendId] = useState('');
  const [cpuCores, setCpuCores] = useState('');
  const [memGib, setMemGib] = useState('');
  const [diskGib, setDiskGib] = useState('');
  const [gpuMode, setGpuMode] = useState<GpuGrantMode>(GpuGrantMode.None);
  const [gpuPciAddresses, setGpuPciAddresses] = useState<string[]>([]);
  const [sharedLimitGib, setSharedLimitGib] = useState('');
  const gpusQuery = useServerGpus(serverId, true, Boolean(serverId));
  const pickerMode: GpuPickerMode = gpuMode === GpuGrantMode.None
    ? 'none'
    : gpuMode === GpuGrantMode.All
      ? 'all'
      : 'specific';
  const setPickerMode = (mode: GpuPickerMode) => {
    if (mode === 'none') setGpuMode(GpuGrantMode.None);
    else if (mode === 'all') setGpuMode(GpuGrantMode.All);
    else setGpuMode(GpuGrantMode.Pci);
  };
  const [serverExpiresAt, setServerExpiresAt] = useState('');
  const [poolExpiresAt, setPoolExpiresAt] = useState('');
  const [backendExpiresAt, setBackendExpiresAt] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{
    resource: 'server-grants' | 'storage-pool-grants' | 'shared-backend-grants';
    id: string;
    label: string;
  } | null>(null);

  const servers = serversQuery.data ?? [];
  const pools = poolsQuery.data ?? [];
  const backends = backendsQuery.data ?? [];

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['grants', kind, subject.id] });
    void queryClient.invalidateQueries({ queryKey: ['me', 'access'] });
  };

  const serverMutation = useMutation({
    mutationFn: () => {
      const inventory = gpusQuery.data?.items ?? [];
      const pciAddresses = resolveGpuPciAddresses(pickerMode, gpuPciAddresses, inventory);
      return api.put<ServerGrantDto>(`${prefix}/server-grants/${serverId}`, {
        cpuMillis: coresToMillis(cpuCores),
        memBytes: gibToBytes(memGib),
        diskBytes: gibToBytes(diskGib),
        gpu: {
          mode: gpuMode,
          pciAddresses: gpuMode === GpuGrantMode.Pci ? pciAddresses : [],
        },
        expiresAt: isoOrNull(serverExpiresAt),
      });
    },
    onSuccess: () => { toast({ title: '服务器授权已保存' }); invalidate(); },
    onError: (error) => toast({ title: '服务器授权失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const poolMutation = useMutation({
    mutationFn: () => api.put<StoragePoolGrantDto>(`${prefix}/storage-pool-grants/${poolId}`, { expiresAt: isoOrNull(poolExpiresAt) }),
    onSuccess: () => { toast({ title: '存储池授权已保存' }); invalidate(); },
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
    onSuccess: () => { toast({ title: '共享存储授权已保存' }); invalidate(); },
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
    <div className="space-y-4" data-testid="canonical-grants">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">服务器授权</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <GrantExpiryInput id="grant-server-expires-at" value={serverExpiresAt} onChange={setServerExpiresAt} />
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              id="grant-server"
              label="服务器"
              value={serverId}
              onChange={(value) => {
                setServerId(value);
                setGpuPciAddresses([]);
                setGpuMode(GpuGrantMode.None);
              }}
              options={servers.map((server) => [server.id, server.name])}
            />
            <div className="space-y-1.5">
              <Label>GPU 授权</Label>
              <GpuPicker
                serverId={serverId}
                admin
                mode={pickerMode}
                onModeChange={setPickerMode}
                value={gpuPciAddresses}
                onChange={setGpuPciAddresses}
                idPrefix="grant-gpu"
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField id="grant-cpu" label="CPU（核，空=不限）" value={cpuCores} onChange={setCpuCores} />
            <NumberField id="grant-memory" label="内存（G，空=不限）" value={memGib} onChange={setMemGib} hint={gibHint(memGib)} />
            <NumberField id="grant-disk" label="磁盘（G，空=不限）" value={diskGib} onChange={setDiskGib} hint={gibHint(diskGib)} />
          </div>
          <p className="text-xs text-muted-foreground">保存后到期时间：{expirySummary(serverExpiresAt)}</p>
          <Button onClick={() => serverMutation.mutate()} disabled={!serverId || serverMutation.isPending}>
            保存服务器授权
          </Button>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">已授权服务器</p>
            <GrantList
              rows={serverGrantsQuery.data ?? []}
              label={(row) => `${serverName(row.serverId, servers)} · CPU ${row.cpuMillis === null ? '不限' : formatCpu(row.cpuMillis)} · 到期 ${expiryLabel(row.expiresAt)}`}
              target={(row) => row.serverId}
              phase={(row) => effectiveAccessQuery.data?.servers.find((server) => server.serverId === row.serverId)?.accessPhase}
              onDelete={(id, label) => setDeleteTarget({ resource: 'server-grants', id, label })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">存储池授权</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              id="grant-pool"
              label="存储池"
              value={poolId}
              onChange={setPoolId}
              options={pools.filter((pool) => pool.registered).map((pool) => [
                pool.id,
                `${pool.displayName ?? pool.incusName} · ${serverName(pool.serverId, servers)}`,
              ])}
            />
            <GrantExpiryInput id="grant-pool-expires-at" value={poolExpiresAt} onChange={setPoolExpiresAt} />
          </div>
          <p className="text-xs text-muted-foreground">保存后到期时间：{expirySummary(poolExpiresAt)}</p>
          <Button onClick={() => poolMutation.mutate()} disabled={!poolId || poolMutation.isPending}>
            保存存储池授权
          </Button>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">已授权存储池</p>
            <GrantList
              rows={poolGrantsQuery.data ?? []}
              label={(row) => `${poolName(row.poolId, pools, servers)} · 到期 ${expiryLabel(row.expiresAt)}`}
              target={(row) => row.poolId}
              onDelete={(id, label) => setDeleteTarget({ resource: 'storage-pool-grants', id, label })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">共享存储授权</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              id="grant-backend"
              label="共享存储"
              value={backendId}
              onChange={setBackendId}
              options={backends.map((backend) => [backend.id, backend.displayName ?? backend.name])}
            />
            <NumberField id="grant-shared-limit" label="额度（G）" value={sharedLimitGib} onChange={setSharedLimitGib} hint={gibHint(sharedLimitGib)} />
          </div>
          <GrantExpiryInput id="grant-backend-expires-at" value={backendExpiresAt} onChange={setBackendExpiresAt} />
          <p className="text-xs text-muted-foreground">保存后到期时间：{expirySummary(backendExpiresAt)}</p>
          <Button
            onClick={() => backendMutation.mutate()}
            disabled={!backendId || !sharedLimitGib || backendMutation.isPending}
          >
            保存共享存储授权
          </Button>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">已授权共享后端</p>
            <GrantList
              rows={backendGrantsQuery.data ?? []}
              label={(row) => `${backendName(row.sharedBackendId, backends)} · ${approxGibHint(row.limitBytes).replace(/^约 /, '')} · 到期 ${expiryLabel(row.expiresAt)}`}
              target={(row) => row.sharedBackendId}
              onDelete={(id, label) => setDeleteTarget({ resource: 'shared-backend-grants', id, label })}
            />
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除授权？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{deleteTarget?.label}」。删除后该主体将立即失去对应资源访问权（若仍在宽限期内，以服务端状态为准）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) remove.mutate({ resource: deleteTarget.resource, id: deleteTarget.id });
              }}
              disabled={remove.isPending}
            >
              {remove.isPending ? '删除中...' : '确认删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function GrantExpiryInput({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>到期时间（留空=不设期限）</Label>
      <Input id={id} type="datetime-local" value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function GrantList<T extends { id: string; expiresAt: string | null }>({
  rows,
  label,
  target,
  phase,
  onDelete,
}: {
  rows: T[];
  label: (row: T) => string;
  target: (row: T) => string;
  phase?: (row: T) => GrantExpiryPhase | undefined;
  onDelete: (id: string, label: string) => void;
}) {
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">暂无授权。</p>;
  return (
    <div className="divide-y rounded-md border">
      {rows.map((row) => {
        const phaseValue = expiryPhase(row.expiresAt, phase?.(row));
        const rowLabel = label(row);
        return (
          <div key={row.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
            <div className="min-w-0 space-y-1">
              <p className="break-all">{rowLabel}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={phaseValue === 'lost' ? 'destructive' : phaseValue === 'grace' ? 'warning' : 'outline'}>
                  {grantExpiryPhaseLabel(phaseValue)}
                </Badge>
                {phaseValue === 'grace' && (
                  <span className="text-[11px] text-muted-foreground">到期后仍可短暂使用，直至宽限期结束</span>
                )}
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => onDelete(target(row), rowLabel)}>删除</Button>
          </div>
        );
      })}
    </div>
  );
}

function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      >
        <option value="">请选择</option>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
    </div>
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
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" min="0" step="any" value={value} onChange={(event) => onChange(event.target.value)} />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
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
  return servers.find((server) => server.id === id)?.name ?? id;
}

function poolName(id: string, pools: StoragePoolDto[], servers: ServerDto[]): string {
  const pool = pools.find((item) => item.id === id);
  if (!pool) return id;
  return `${pool.displayName ?? pool.incusName} · ${serverName(pool.serverId, servers)}`;
}

function backendName(id: string, backends: SharedBackendDto[]): string {
  const backend = backends.find((item) => item.id === id);
  return backend?.displayName ?? backend?.name ?? id;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请稍后重试';
}
