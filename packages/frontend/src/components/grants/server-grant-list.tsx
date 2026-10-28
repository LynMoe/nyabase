import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { GrantBundleDto, PatchServerGrantRequest, ServerGrantDto, ServerGrantOverrides } from '@nyabase/common';
import { useActionMutation } from '../../hooks/use-action-mutation.js';
import { api } from '../../lib/api.js';
import { grantedGpuIndexLabel } from '../../lib/grant-quota.js';
import { cn } from '../../lib/utils.js';
import { useGpuDevices } from '../gpu/gpu-picker.js';
import {
  GRANT_BUNDLE_FIELDS,
  type KnownQuotas,
  dataDiskSummary,
  quotaSummaryParts,
  overrideDraftFrom,
  overriddenFields,
  parseOverrideDraft,
} from '../../lib/grant-bundle-form.js';
import { SectionCard } from '../layout/section-card.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
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

/** Same override set: the same fields, each with the same value. */
export function sameOverrides(left: ServerGrantOverrides, right: ServerGrantOverrides): boolean {
  const fields = overriddenFields(left);
  return fields.length === overriddenFields(right).length
    && fields.every((field) => Object.hasOwn(right, field) && (left[field] ?? null) === (right[field] ?? null));
}

/** A server grant picked for deletion. */
export interface ServerGrantDeleteTarget {
  serverId: string;
  label: string;
}

/**
 * The user's server grants, one row per server: its name, the bundle, the
 * effective quotas and the data disks summed, the expiry. A row expands in
 * place into its editor (quotas, expiry), the GPUs picked and the data disks.
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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (serverId: string) => setExpanded((current) => {
    const next = new Set(current);
    if (!next.delete(serverId)) next.add(serverId);
    return next;
  });
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
            const open = expanded.has(grant.serverId);
            const panelId = `grant-panel-${grant.serverId}`;
            return (
              <li key={grant.id} data-testid={`grant-server-${grant.serverId}`}>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={panelId}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-hidden"
                  onClick={() => toggle(grant.serverId)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-base font-medium">{serverName(grant.serverId, servers)}</span>
                      <span className="text-sm text-muted-foreground">模板 {grant.bundleName}</span>
                      {overridden ? <Badge variant="secondary">已覆盖</Badge> : null}
                      {phase === 'live' ? null : <PhaseBadge phase={phase} />}
                    </span>
                    <span className="mt-1 block text-sm text-muted-foreground tabular-nums">
                      {[...quotaSummaryParts(grant, server ?? {}), dataDiskSummary(grant.storagePools)].join(' · ')}
                    </span>
                  </span>
                  <span className="hidden shrink-0 text-sm text-muted-foreground sm:inline">
                    {grant.expiresAt ? `至 ${expiryLabel(grant.expiresAt)}` : '永久'}
                  </span>
                  <ChevronDown
                    className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
                  />
                </button>
                {open ? (
                  <div id={panelId} className="border-t bg-muted/20 px-4 py-4">
                    <ServerGrantDetail
                      // Remount after a save so the editor starts from the stored grant.
                      key={grant.updatedAt}
                      userId={userId}
                      grant={grant}
                      bundle={bundles.find((row) => row.id === grant.bundleId)}
                      gpuEnabled={server?.gpuEnabled}
                      onDelete={() => onDelete({
                        serverId: grant.serverId,
                        label: `${grant.bundleName} · ${serverName(grant.serverId, servers)}`,
                      })}
                      onDeleteDisk={onDeleteDisk}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

/** The GPUs picked for the user on the server, by index (the live inventory gives the indexes). */
function GrantedGpus({ serverId, pciAddresses }: { serverId: string; pciAddresses: string[] }) {
  const inventory = useGpuDevices(serverId, 'all', pciAddresses.length > 0).data?.items ?? [];
  return <>{grantedGpuIndexLabel(pciAddresses, inventory)}</>;
}

/**
 * One server grant, expanded: its quotas as inputs (a switch per field turns
 * an override on and enables the input; off follows the bundle), the expiry,
 * the GPUs picked for the user, and the data disks that live under it.
 */
function ServerGrantDetail({
  userId,
  grant,
  bundle,
  gpuEnabled,
  onDelete,
  onDeleteDisk,
}: {
  userId: string;
  grant: ServerGrantDto;
  bundle: GrantBundleDto | undefined;
  gpuEnabled: boolean | undefined;
  onDelete: () => void;
  onDeleteDisk: (target: DataDiskDeleteTarget) => void;
}) {
  const access = useLiveServerAccess(userId, grant.serverId);
  const invalidate = useInvalidateGrants(userId);
  const known = knownBundleQuotas(grant, bundle);
  const [draft, setDraft] = useState(() => overrideDraftFrom(grant.overrides));
  const [expiresAt, setExpiresAt] = useState(() => initialExpiry(grant.expiresAt));
  const overrides = parseOverrideDraft(draft, { overrides: grant.overrides, bundle: known });
  // The expiry input has minute precision, so it is compared as text against the stored one.
  const expiryChanged = expiresAt !== initialExpiry(grant.expiresAt);
  const dirty = overrides === undefined || !sameOverrides(overrides, grant.overrides) || expiryChanged;
  const reset = () => {
    setDraft(overrideDraftFrom(grant.overrides));
    setExpiresAt(initialExpiry(grant.expiresAt));
  };
  const save = useActionMutation({
    mutationFn: () => {
      const body: PatchServerGrantRequest = {
        overrides: overrides ?? {},
        expiresAt: expiryChanged ? isoOrNull(expiresAt) : grant.expiresAt,
      };
      return api.patch<ServerGrantDto>(`/users/${userId}/server-grants/${grant.serverId}`, body);
    },
    successTitle: '授权已保存',
    errorTitle: '授权保存失败',
    onSuccess: invalidate,
  });
  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground">
          授权模板「{grant.bundleName}」：未开启「修改」的额度跟随模板，模板修改后立即随之变化。
        </p>
        <Button size="sm" variant="ghost-destructive" onClick={onDelete}>删除授权</Button>
      </div>
      <OverrideQuotaFields
        idPrefix={`grant-${grant.serverId}`}
        bundle={known}
        draft={draft}
        onChange={setDraft}
        gpuEnabled={gpuEnabled}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <GrantExpiryInput id={`grant-${grant.serverId}-expires-at`} value={expiresAt} onChange={setExpiresAt} />
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 sm:self-start">
          <span className="text-muted-foreground">分配的 GPU</span>
          <span className="font-medium tabular-nums">
            {access ? <GrantedGpus serverId={grant.serverId} pciAddresses={access.gpuPciAddresses} /> : '—'}
          </span>
        </div>
      </div>
      {dirty ? (
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={reset} disabled={save.isPending}>还原</Button>
          <Button
            onClick={() => save.mutate()}
            disabled={overrides === undefined || save.isPending}
            data-testid={`grant-save-${grant.serverId}`}
          >
            {save.isPending ? '保存中...' : '保存'}
          </Button>
        </div>
      ) : null}
      <DataDiskSection userId={userId} grant={grant} access={access} onDelete={onDeleteDisk} />
    </div>
  );
}
