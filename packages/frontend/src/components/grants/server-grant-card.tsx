import { useState } from 'react';
import type { GrantBundleDto, PatchServerGrantRequest, ServerGrantDto } from '@nyabase/common';
import { useActionMutation } from '../../hooks/use-action-mutation.js';
import { api } from '../../lib/api.js';
import {
  GRANT_BUNDLE_FIELDS,
  GRANT_FIELD_LABELS,
  type KnownQuotas,
  type OverrideDraft,
  formatQuotaValue,
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

/**
 * One server grant of the user: its bundle, the effective quotas (overridden
 * ones marked, with the bundle's value beside them), expiry, the GPUs picked
 * for the user, and the data disks that live under it.
 */
export function ServerGrantCard({
  userId,
  grant,
  bundle,
  onDelete,
  onDeleteDisk,
}: {
  userId: string;
  grant: ServerGrantDto;
  bundle: GrantBundleDto | undefined;
  onDelete: () => void;
  onDeleteDisk: (target: DataDiskDeleteTarget) => void;
}) {
  const servers = useGrantServers().data ?? [];
  const server = servers.find((row) => row.id === grant.serverId);
  const access = useLiveServerAccess(userId, grant.serverId);
  const [editing, setEditing] = useState(false);
  const overridden = new Set(overriddenFields(grant.overrides));
  return (
    <SectionCard
      title={(
        <span className="flex flex-wrap items-center gap-2">
          {grant.bundleName}
          <span className="text-sm font-normal text-muted-foreground">·</span>
          <span className="text-sm font-normal"><ResourceRef kind="server" id={grant.serverId} name={serverName(grant.serverId, servers)} /></span>
        </span>
      )}
      actions={(
        <>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>编辑</Button>
          <Button size="sm" variant="ghost" onClick={onDelete}>删除</Button>
        </>
      )}
      testId={`grant-server-${grant.serverId}`}
    >
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
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">分配的 GPU</span>
              <span className="break-all font-mono text-xs">{access.gpuPciAddresses.join(', ')}</span>
            </span>
          ) : null}
        </div>
        <DataDiskSection userId={userId} grant={grant} access={access} onDelete={onDeleteDisk} />
      </div>
      {editing ? (
        <EditServerGrantDialog
          userId={userId}
          grant={grant}
          bundle={knownBundleQuotas(grant, bundle)}
          gpuEnabled={server?.gpuEnabled}
          title={`编辑「${grant.bundleName} · ${serverName(grant.serverId, servers)}」`}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </SectionCard>
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
