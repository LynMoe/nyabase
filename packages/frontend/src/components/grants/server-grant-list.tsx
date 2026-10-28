import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { GrantBundleDto, PatchServerGrantRequest, ServerGrantDto } from '@nyabase/common';
import { useActionMutation } from '../../hooks/use-action-mutation.js';
import { api } from '../../lib/api.js';
import { grantedGpuIndexLabel } from '../../lib/grant-quota.js';
import { useGpuDevices } from '../gpu/gpu-picker.js';
import {
  GRANT_BUNDLE_FIELDS,
  GRANT_FIELD_LABELS,
  type KnownQuotas,
  type OverrideDraft,
  dataDiskSummary,
  formatQuotaValue,
  quotaSummaryParts,
  overrideDraftFrom,
  overriddenFields,
  parseOverrideDraft,
} from '../../lib/grant-bundle-form.js';
import { SectionCard } from '../layout/section-card.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { DataDiskSection, type DataDiskDeleteTarget } from './data-disk-section.js';
import { GrantExpiryInput, OverrideQuotaFields, PhaseBadge } from './grant-form-parts.js';
import {
  expiryLabel,
  expiryPhase,
  initialExpiry,
  isoOrNull,
  serverName,
  useGrantServers,
  useInvalidateGrants,
  useLiveServerAccess,
} from './use-grant-panel-data.js';

/**
 * What a grant follows: the bundle's values; while the bundle is not loaded,
 * a followed field's effective value is the bundle's, an overridden one's is unknown.
 */
export function knownBundleQuotas(grant: ServerGrantDto, bundle: GrantBundleDto | undefined): KnownQuotas {
  if (bundle) return bundle;
  const overridden = new Set(overriddenFields(grant.overrides));
  const known: KnownQuotas = {};
  for (const field of GRANT_BUNDLE_FIELDS) {
    if (!overridden.has(field)) known[field] = grant[field];
  }
  return known;
}

/** A server grant picked for deletion. */
export interface ServerGrantDeleteTarget {
  serverId: string;
  label: string;
}

/**
 * The user's server grants, one compact row per server: its name, the
 * bundle, the effective quotas, the data disks summed, the expiry. A row
 * opens the grant's detail.
 */
export function ServerGrantList({
  userId,
  grants,
  bundles,
  onDelete,
  onDeleteDisk,
}: {
  userId: string;
  grants: ServerGrantDto[];
  bundles: GrantBundleDto[];
  onDelete: (target: ServerGrantDeleteTarget) => void;
  onDeleteDisk: (target: DataDiskDeleteTarget) => void;
}) {
  const servers = useGrantServers().data ?? [];
  const [openServerId, setOpenServerId] = useState<string | null>(null);
  const open = grants.find((grant) => grant.serverId === openServerId);
  return (
    <SectionCard title="服务器授权" flush={grants.length > 0} testId="grant-servers">
      {grants.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无服务器授权。</p>
      ) : (
        <ul className="divide-y">
          {grants.map((grant) => {
            const server = servers.find((row) => row.id === grant.serverId);
            const overridden = overriddenFields(grant.overrides).length > 0;
            const phase = expiryPhase(grant.expiresAt);
            return (
              <li key={grant.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-hidden"
                  onClick={() => setOpenServerId(grant.serverId)}
                  data-testid={`grant-server-${grant.serverId}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-medium">{serverName(grant.serverId, servers)}</span>
                      <span className="text-xs text-muted-foreground">模板 {grant.bundleName}</span>
                      {overridden ? <Badge variant="secondary" className="px-1.5 py-0 text-[11px]">已覆盖</Badge> : null}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground tabular-nums">
                      {[...quotaSummaryParts(grant, server ?? {}), dataDiskSummary(grant.storagePools)].join(' · ')}
                    </span>
                  </span>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    {grant.expiresAt ? `至 ${expiryLabel(grant.expiresAt)}` : '永久'}
                  </span>
                  {phase === 'live' ? null : <PhaseBadge phase={phase} />}
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {open ? (
        <ServerGrantDetailDialog
          userId={userId}
          grant={open}
          bundle={bundles.find((row) => row.id === open.bundleId)}
          onClose={() => setOpenServerId(null)}
          onDelete={() => {
            setOpenServerId(null);
            onDelete({ serverId: open.serverId, label: `${open.bundleName} · ${serverName(open.serverId, servers)}` });
          }}
          onDeleteDisk={onDeleteDisk}
        />
      ) : null}
    </SectionCard>
  );
}

/** The GPUs picked for the user on the server, by index (the live inventory gives the indexes). */
function GrantedGpus({ serverId, pciAddresses }: { serverId: string; pciAddresses: string[] }) {
  const inventory = useGpuDevices(serverId, 'all', pciAddresses.length > 0).data?.items ?? [];
  return <>{grantedGpuIndexLabel(pciAddresses, inventory)}</>;
}

/**
 * One server grant: its bundle, the effective quotas (overridden ones marked,
 * with the bundle's value beside them), expiry, the GPUs picked for the user,
 * and the data disks that live under it.
 */
function ServerGrantDetailDialog({
  userId,
  grant,
  bundle,
  onClose,
  onDelete,
  onDeleteDisk,
}: {
  userId: string;
  grant: ServerGrantDto;
  bundle: GrantBundleDto | undefined;
  onClose: () => void;
  onDelete: () => void;
  onDeleteDisk: (target: DataDiskDeleteTarget) => void;
}) {
  const servers = useGrantServers().data ?? [];
  const server = servers.find((row) => row.id === grant.serverId);
  const access = useLiveServerAccess(userId, grant.serverId);
  const [editing, setEditing] = useState(false);
  const overridden = new Set(overriddenFields(grant.overrides));
  const name = serverName(grant.serverId, servers);
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-3xl" data-testid={`grant-detail-${grant.serverId}`}>
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <ResourceRef kind="server" id={grant.serverId} name={name} />
          </DialogTitle>
          <DialogDescription>授权模板「{grant.bundleName}」</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            {GRANT_BUNDLE_FIELDS.map((field) => (
              <div key={field} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{GRANT_FIELD_LABELS[field]}</dt>
                <dd className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <span className="tabular-nums">{formatQuotaValue(field, grant[field], server ?? {})}</span>
                  {overridden.has(field) ? (
                    <>
                      <Badge variant="secondary">已覆盖</Badge>
                      {bundle ? (
                        <span className="text-xs text-muted-foreground">模板 {formatQuotaValue(field, bundle[field], server ?? {})}</span>
                      ) : null}
                    </>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">到期</span>
              {expiryLabel(grant.expiresAt)}
              <PhaseBadge phase={expiryPhase(grant.expiresAt)} />
            </span>
            {access && access.gpuPciAddresses.length > 0 ? (
              <span className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">分配的 GPU</span>
                <span className="tabular-nums"><GrantedGpus serverId={grant.serverId} pciAddresses={access.gpuPciAddresses} /></span>
              </span>
            ) : null}
          </div>
          <DataDiskSection userId={userId} grant={grant} access={access} onDelete={onDeleteDisk} />
        </div>
        <DialogFooter>
          <Button variant="ghost-destructive" onClick={onDelete}>删除授权</Button>
          <Button variant="outline" onClick={() => setEditing(true)}>编辑额度与到期</Button>
        </DialogFooter>
        {editing ? (
          <EditServerGrantDialog
            userId={userId}
            grant={grant}
            bundle={knownBundleQuotas(grant, bundle)}
            gpuEnabled={server?.gpuEnabled}
            title={`编辑「${grant.bundleName} · ${name}」`}
            onClose={() => setEditing(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Overrides and expiry of one grant; the overrides sent are the complete set. */
function EditServerGrantDialog({
  userId,
  grant,
  bundle,
  gpuEnabled,
  title,
  onClose,
}: {
  userId: string;
  grant: ServerGrantDto;
  bundle: KnownQuotas;
  gpuEnabled: boolean | undefined;
  title: string;
  onClose: () => void;
}) {
  const invalidate = useInvalidateGrants(userId);
  const [draft, setDraft] = useState<OverrideDraft>(() => overrideDraftFrom(grant.overrides));
  const [expiresAt, setExpiresAt] = useState(() => initialExpiry(grant.expiresAt));
  const overrides = parseOverrideDraft(draft, { overrides: grant.overrides, bundle });
  const save = useActionMutation({
    mutationFn: () => {
      const body: PatchServerGrantRequest = { overrides: overrides ?? {}, expiresAt: isoOrNull(expiresAt) };
      return api.patch<ServerGrantDto>(`/users/${userId}/server-grants/${grant.serverId}`, body);
    },
    successTitle: '授权已保存',
    errorTitle: '授权保存失败',
    onSuccess: () => { onClose(); invalidate(); },
  });
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>未勾选「修改」的字段跟随授权模板，模板修改后立即随之变化。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <OverrideQuotaFields
            idPrefix={`grant-${grant.serverId}`}
            bundle={bundle}
            draft={draft}
            onChange={setDraft}
            gpuEnabled={gpuEnabled}
          />
          <GrantExpiryInput id={`grant-${grant.serverId}-expires-at`} value={expiresAt} onChange={setExpiresAt} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => save.mutate()} disabled={overrides === undefined || save.isPending}>
            {save.isPending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
