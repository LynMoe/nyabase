import { type ReactNode, useState } from 'react';
import type { ServerGrantDto, SharedBackendGrantDto, StoragePoolGrantDto } from '@nyabase/common';
import { formatGibInput, formatVcpuInput } from '../../lib/utils.js';
import { api } from '../../lib/api.js';
import { useActionMutation } from '../../hooks/use-action-mutation.js';
import { FormField, SelectField } from '../layout/form-field.js';
import { QueryLoadingState } from '../query-state.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { Switch } from '../ui/switch.js';
import { ServerGrantGpu } from '../gpu/gpu-sections.js';
import { grantSubjectPath } from '../../lib/scoped-paths.js';
import {
  backendName,
  coresToMillis,
  defaultExpiryLocal,
  expirySummary,
  gibHint,
  gibToBytes,
  grantablePools,
  type GrantSubject,
  initialExpiry,
  isoOrNull,
  poolName,
  serverName,
  useGrantBackends,
  useGrantPools,
  useGrantServers,
  useInvalidateGrants,
  useSubjectGrants,
} from './use-grant-panel-data.js';

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

/** Add (no `grant`) or edit one server grant of the subject. */
export function ServerGrantDialog({
  subject,
  grant,
  onClose,
}: {
  subject: GrantSubject;
  grant?: ServerGrantDto;
  onClose: () => void;
}) {
  const serversQuery = useGrantServers();
  const grantedIds = new Set((useSubjectGrants(subject, 'servers').data ?? []).map((row) => row.serverId));
  const invalidate = useInvalidateGrants(subject);
  const allServers = serversQuery.data ?? [];
  const servers = grant ? allServers : allServers.filter((server) => !grantedIds.has(server.id));
  const [cpuCores, setCpuCores] = useState(() => grant?.cpuMillis == null ? '' : formatVcpuInput(grant.cpuMillis));
  const [memGib, setMemGib] = useState(() => grant?.memBytes == null ? '' : formatGibInput(grant.memBytes));
  const [diskGib, setDiskGib] = useState(() => grant?.diskBytes == null ? '' : formatGibInput(grant.diskBytes));
  const [gpuPciAddresses, setGpuPciAddresses] = useState<string[]>(() => [...(grant?.gpuPciAddresses ?? [])]);
  const [expiresAt, setExpiresAt] = useState(() => initialExpiry(grant?.expiresAt));
  const idPrefix = grant ? `grant-${grant.serverId}` : 'grant';

  return (
    <GrantDialog
      noun="服务器授权"
      idPrefix={idPrefix}
      wide
      target={grant
        ? { mode: 'edit', id: grant.serverId, name: serverName(grant.serverId, allServers) }
        : {
          mode: 'create',
          label: '服务器',
          placeholder: '选择服务器',
          options: servers.map((server) => [server.id, server.name]),
          empty: '没有可添加的服务器。',
          loading: serversQuery.isLoading,
          error: serversQuery.isError,
          onRetry: () => { void serversQuery.refetch(); },
        }}
      onTargetChange={() => setGpuPciAddresses([])}
      save={(serverId) => api.put<ServerGrantDto>(`${grantSubjectPath(subject.kind, subject.id)}/server-grants/${serverId}`, {
        cpuMillis: coresToMillis(cpuCores),
        memBytes: gibToBytes(memGib),
        diskBytes: gibToBytes(diskGib),
        gpuPciAddresses,
        expiresAt: isoOrNull(expiresAt),
      })}
      onSaved={() => { onClose(); invalidate(); }}
      onOpenChange={(open) => { if (!open) onClose(); }}
    >
      {(serverId) => (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField id={`${idPrefix}-cpu`} label="CPU（核，留空为不限）" value={cpuCores} onChange={setCpuCores} />
            <NumberField id={`${idPrefix}-memory`} label="内存（GiB，留空为不限）" value={memGib} onChange={setMemGib} hint={gibHint(memGib)} />
            <NumberField id={`${idPrefix}-disk`} label="磁盘（GiB，留空为不限，不含共享卷）" value={diskGib} onChange={setDiskGib} hint={gibHint(diskGib)} />
          </div>
          {serverId ? (
            <ServerGrantGpu
              serverId={serverId}
              gpuEnabled={allServers.find((server) => server.id === serverId)?.gpuEnabled === true}
              value={gpuPciAddresses}
              onChange={setGpuPciAddresses}
            />
          ) : null}
          <GrantExpiryInput id={`${idPrefix}-expires-at`} value={expiresAt} onChange={setExpiresAt} />
        </>
      )}
    </GrantDialog>
  );
}

/** Add (no `grant`) or edit one storage pool grant of the subject. */
export function PoolGrantDialog({
  subject,
  grant,
  onClose,
}: {
  subject: GrantSubject;
  grant?: StoragePoolGrantDto;
  onClose: () => void;
}) {
  const serversQuery = useGrantServers();
  const poolsQuery = useGrantPools();
  const serverGrants = useSubjectGrants(subject, 'servers').data ?? [];
  const poolGrants = useSubjectGrants(subject, 'pools').data ?? [];
  const invalidate = useInvalidateGrants(subject);
  const servers = serversQuery.data ?? [];
  const allPools = poolsQuery.data ?? [];
  const grantedServerIds = new Set(serverGrants.map((row) => row.serverId));
  const pools = grant ? allPools : grantablePools(allPools, grantedServerIds, poolGrants);
  const [expiresAt, setExpiresAt] = useState(() => initialExpiry(grant?.expiresAt));
  const idPrefix = grant ? `grant-pool-${grant.poolId}` : 'grant-pool';
  return (
    <GrantDialog
      noun="存储池授权"
      idPrefix={idPrefix}
      target={grant
        ? { mode: 'edit', id: grant.poolId, name: poolName(grant.poolId, allPools, servers) }
        : {
          mode: 'create',
          label: '存储池',
          placeholder: '选择存储池',
          options: pools.map((pool) => [
            pool.id,
            `${pool.displayName ?? pool.incusName} · ${serverName(pool.serverId, servers)}`,
          ]),
          empty: grantedServerIds.size > 0 ? '没有可添加的存储池。' : '请先添加服务器授权。',
          loading: serversQuery.isLoading || poolsQuery.isLoading,
          error: serversQuery.isError || poolsQuery.isError,
          onRetry: () => {
            void serversQuery.refetch();
            void poolsQuery.refetch();
          },
        }}
      save={(poolId) => api.put<StoragePoolGrantDto>(
        `${grantSubjectPath(subject.kind, subject.id)}/storage-pool-grants/${poolId}`,
        { expiresAt: isoOrNull(expiresAt) },
      )}
      onSaved={() => { onClose(); invalidate(); }}
      onOpenChange={(open) => { if (!open) onClose(); }}
    >
      {() => <GrantExpiryInput id={`${idPrefix}-expires-at`} value={expiresAt} onChange={setExpiresAt} />}
    </GrantDialog>
  );
}

/** Add (no `grant`) or edit one shared storage grant of the subject. */
export function BackendGrantDialog({
  subject,
  grant,
  onClose,
}: {
  subject: GrantSubject;
  grant?: SharedBackendGrantDto;
  onClose: () => void;
}) {
  const backendsQuery = useGrantBackends();
  const grantedIds = new Set((useSubjectGrants(subject, 'backends').data ?? []).map((row) => row.sharedBackendId));
  const invalidate = useInvalidateGrants(subject);
  const allBackends = backendsQuery.data ?? [];
  const backends = grant ? allBackends : allBackends.filter((backend) => !grantedIds.has(backend.id));
  const [sharedLimitGib, setSharedLimitGib] = useState(() => (grant ? formatGibInput(grant.limitBytes) : ''));
  const [expiresAt, setExpiresAt] = useState(() => initialExpiry(grant?.expiresAt));
  const idPrefix = grant ? `grant-backend-${grant.sharedBackendId}` : 'grant-backend';
  return (
    <GrantDialog
      noun="共享存储授权"
      idPrefix={idPrefix}
      canSave={Boolean(sharedLimitGib)}
      target={grant
        ? { mode: 'edit', id: grant.sharedBackendId, name: backendName(grant.sharedBackendId, allBackends) }
        : {
          mode: 'create',
          label: '共享存储',
          placeholder: '选择共享存储',
          options: backends.map((backend) => [backend.id, backend.displayName ?? backend.name]),
          empty: '没有可添加的共享存储。',
          loading: backendsQuery.isLoading,
          error: backendsQuery.isError,
          onRetry: () => { void backendsQuery.refetch(); },
        }}
      save={(backendId) => {
        const limitBytes = gibToBytes(sharedLimitGib);
        if (limitBytes === null) return Promise.reject(new Error('请填写额度'));
        return api.put<SharedBackendGrantDto>(
          `${grantSubjectPath(subject.kind, subject.id)}/shared-backend-grants/${backendId}`,
          { limitBytes, expiresAt: isoOrNull(expiresAt) },
        );
      }}
      onSaved={() => { onClose(); invalidate(); }}
      onOpenChange={(open) => { if (!open) onClose(); }}
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
