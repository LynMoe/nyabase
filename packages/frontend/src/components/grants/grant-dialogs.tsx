import { useState, type ReactNode } from 'react';
import type {
  ServerDto,
  ServerGrantDto,
  SharedBackendDto,
  SharedBackendGrantDto,
  StoragePoolDto,
  StoragePoolGrantDto,
} from '@nyabase/common';
import { formatGibInput, formatVcpuInput } from '../../lib/utils.js';
import { api } from '../../lib/api.js';
import { useActionMutation } from '../../hooks/use-action-mutation.js';
import { FormField } from '../layout/form-field.js';
import { SelectField } from '../layout/select-field.js';
import { QueryLoadingState } from '../query-state.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { Switch } from '../ui/switch.js';
import { ServerGrantGpu } from '../gpu/gpu-sections.js';
import { truncateId } from '../refs/technical-id.js';
import {
  coresToMillis,
  defaultExpiryLocal,
  expirySummary,
  gibHint,
  gibToBytes,
  initialExpiry,
  isoOrNull,
  serverName,
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

export type ChoiceState = { loading?: boolean; error?: boolean; onRetry?: () => void };

export function ServerGrantDialog({
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
  const [gpuPciAddresses, setGpuPciAddresses] = useState<string[]>(() => [...(grant?.gpuPciAddresses ?? [])]);
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
      onTargetChange={() => setGpuPciAddresses([])}
      save={(serverId) => api.put<ServerGrantDto>(`${prefix}/server-grants/${serverId}`, {
        cpuMillis: coresToMillis(cpuCores),
        memBytes: gibToBytes(memGib),
        diskBytes: gibToBytes(diskGib),
        gpuPciAddresses,
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
            <ServerGrantGpu
              serverId={serverId}
              gpuEnabled={servers.find((server) => server.id === serverId)?.gpuEnabled === true}
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

export function PoolGrantDialog({
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

export function BackendGrantDialog({
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

export function GrantExpiryInput({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
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

export function NumberField({
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
