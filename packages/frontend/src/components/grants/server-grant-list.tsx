import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  GRANT_EXPIRY_GRACE_DAYS,
  type GrantBundleDto,
  type PatchServerGrantRequest,
  type ServerGrantDto,
  type ServerGrantOverrides,
} from '@nyabase/common';
import { useActionMutation } from '../../hooks/use-action-mutation.js';
import { api } from '../../lib/api.js';
import { poolDisplayName } from '../../lib/data-disks.js';
import { grantedGpuIndexLabel } from '../../lib/grant-quota.js';
import { useServerPools } from '../../lib/server-queries.js';
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
import { diffDataDisks, sameDataDisks } from '../../lib/grant-data-disks.js';
import { ConfirmDialog } from '../layout/confirm-dialog.js';
import { SectionCard } from '../layout/section-card.js';
import { truncateId } from '../refs/technical-id.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { useUserPoolData } from './data-disk-editor.js';
import { GrantExpiryInput, OverrideDataDisks, OverrideQuotaFields, PhaseBadge } from './grant-form-parts.js';
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
  if (!overridden.has('dataDisks')) known.dataDisks = grant.dataDisks;
  return known;
}

/** Same override set: the same fields, each with the same value (a data-disk list in any order). */
export function sameOverrides(left: ServerGrantOverrides, right: ServerGrantOverrides): boolean {
  const fields = overriddenFields(left);
  return fields.length === overriddenFields(right).length
    && fields.every((field) => {
      if (!Object.hasOwn(right, field)) return false;
      if (field === 'dataDisks') return sameDataDisks(left.dataDisks ?? [], right.dataDisks ?? []);
      return (left[field] ?? null) === (right[field] ?? null);
    });
}

/** A server grant picked for deletion. */
export interface ServerGrantDeleteTarget {
  serverId: string;
  label: string;
}

/**
 * The user's server grants, one row per server: its name, the bundle, the
 * effective quotas and data disks, the expiry. A row expands in place into
 * its editor (quotas, data disks, expiry) and the GPUs picked.
 */
export function ServerGrantList({
  userId,
  grants,
  bundles,
  onDelete,
}: {
  userId: string;
  grants: ServerGrantDto[];
  bundles: GrantBundleDto[];
  onDelete: (target: ServerGrantDeleteTarget) => void;
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
                      {[...quotaSummaryParts(grant, server ?? {}), dataDiskSummary(grant.dataDisks)].join(' · ')}
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

/** The disks of `before` that `after` (unknown while the bundle loads) no longer lists. */
function revokedPools(before: ServerGrantDto['dataDisks'], after: ServerGrantDto['dataDisks'] | undefined): string[] {
  return after === undefined ? [] : diffDataDisks(before, after).removed.map((disk) => disk.poolId);
}

/**
 * One server grant, expanded: its quotas as inputs (a switch per field turns
 * an override on and enables the input; off follows the bundle), its data
 * disks (the same switch for the whole list), the expiry and the GPUs picked
 * for the user. Saving a change that drops a data disk asks first: the user's
 * volume there lapses.
 */
function ServerGrantDetail({
  userId,
  grant,
  bundle,
  gpuEnabled,
  onDelete,
}: {
  userId: string;
  grant: ServerGrantDto;
  bundle: GrantBundleDto | undefined;
  gpuEnabled: boolean | undefined;
  onDelete: () => void;
}) {
  const access = useLiveServerAccess(userId, grant.serverId);
  const invalidate = useInvalidateGrants(userId);
  const usedByPool = useUserPoolData(userId, grant.serverId);
  const pools = useServerPools(grant.serverId).data ?? [];
  const known = knownBundleQuotas(grant, bundle);
  const [draft, setDraft] = useState(() => overrideDraftFrom(grant.overrides));
  const [expiresAt, setExpiresAt] = useState(() => initialExpiry(grant.expiresAt));
  const [confirming, setConfirming] = useState(false);
  const overrides = parseOverrideDraft(draft, { overrides: grant.overrides, bundle: known });
  // The expiry input has minute precision, so it is compared as text against the stored one.
  const expiryChanged = expiresAt !== initialExpiry(grant.expiresAt);
  const dirty = overrides === undefined || !sameOverrides(overrides, grant.overrides) || expiryChanged;
  const revoked = overrides ? revokedPools(grant.dataDisks, overrides.dataDisks ?? known.dataDisks) : [];
  const nameOf = (poolId: string) => {
    const pool = pools.find((row) => row.id === poolId);
    return pool ? poolDisplayName(pool) : truncateId(poolId);
  };
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
    onSuccess: () => {
      setConfirming(false);
      invalidate();
    },
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
      <OverrideDataDisks
        idPrefix={`grant-${grant.serverId}`}
        serverId={grant.serverId}
        bundle={known}
        draft={draft}
        onChange={setDraft}
        usedByPool={usedByPool}
        stored={grant.overrides.dataDisks}
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
            onClick={() => { if (revoked.length > 0) setConfirming(true); else save.mutate(); }}
            disabled={overrides === undefined || save.isPending}
            data-testid={`grant-save-${grant.serverId}`}
          >
            {save.isPending ? '保存中...' : '保存'}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title="撤销数据盘？"
        description={`保存后 ${revoked.map(nameOf).join('、')} 不再在该用户的授权内：该用户在这些盘上的数据卷立即从所有容器卸载，${GRANT_EXPIRY_GRACE_DAYS} 天后删除（期间重新授权可保留）。`}
        confirmLabel="确认保存"
        pendingLabel="保存中..."
        pending={save.isPending}
        onConfirm={() => save.mutate()}
        onOpenChange={(open) => { if (!open) setConfirming(false); }}
      />
    </div>
  );
}
