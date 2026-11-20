import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type CreateGrantBundleRequest,
  FailureCode,
  type GrantBundleDto,
  type GrantBundlePreviewDto,
  type PatchGrantBundleRequest,
  zGrantBundleName,
} from '@nyabase/common';
import { DataDiskEditor } from '../../components/grants/data-disk-editor.js';
import { BundleQuotaFields } from '../../components/grants/grant-form-parts.js';
import { invalidateOwnAccess, serverName, useGrantServers } from '../../components/grants/use-grant-panel-data.js';
import { FormField, SelectField } from '../../components/layout/form-field.js';
import { Alert, AlertDescription } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { toast } from '../../hooks/use-toast.js';
import { api } from '../../lib/api.js';
import { ApiError, apiErrorCurrent, errorMessage } from '../../lib/api-error.js';
import {
  NEW_BUNDLE_QUOTA_TEXTS,
  type QuotaTexts,
  bundleChanges,
  isGrantBundleDto,
  parseQuotaTexts,
  quotasToTexts,
  rebaseBundleDraft,
} from '../../lib/grant-bundle-form.js';
import { type DataDiskDraft, dataDiskDraftFrom, parseDataDiskDraft } from '../../lib/grant-data-disks.js';
import { queryKeys } from '../../lib/query-keys.js';
import { failureCodeLabel } from '../../lib/status-labels.js';
import { BundlePreview } from './bundle-preview.js';
import { ServerProfilePanel } from './server-profile-panel.js';

/** Bundle errors the page explains in its own words; anything else keeps the server's message. */
export function bundleErrorText(error: unknown): string {
  if (error instanceof ApiError && (
    error.code === FailureCode.GrantBundleConflict || error.code === FailureCode.GrantBundleInUse
  )) {
    return failureCodeLabel(error.code) ?? errorMessage(error);
  }
  return errorMessage(error);
}

function useInvalidateBundles() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.grantBundles.all });
    // Every grant that follows the bundle changes with it.
    void queryClient.invalidateQueries({ queryKey: ['grants'] });
    invalidateOwnAccess(queryClient);
  };
}

function nameError(name: string): string | null {
  return zGrantBundleName.safeParse(name).success ? null : '名称为 1–64 个字符';
}

function NameField({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <FormField id={id} label="名称" error={value && nameError(value)}>
      <Input id={id} value={value} maxLength={64} onChange={(event) => onChange(event.target.value)} />
    </FormField>
  );
}

/** The bundle's data disks: local pools of its server, each with an optional ceiling under the disk total. */
function BundleDataDisks({
  id,
  serverId,
  draft,
  onChange,
  known,
}: {
  id: string;
  serverId: string;
  draft: DataDiskDraft;
  onChange: (draft: DataDiskDraft) => void;
  known?: GrantBundleDto['dataDisks'];
}) {
  if (!serverId) return null;
  return (
    <section className="space-y-2" aria-label="数据盘">
      <div>
        <h3 className="text-sm font-medium">数据盘</h3>
        <p className="text-xs text-muted-foreground">
          勾选的盘上，平台为每个用户建一个卷并挂载到他在这台服务器上的所有容器；卷按数据弹性伸缩，
          与系统盘共用磁盘总额（系统盘按分配大小计，数据盘按已有数据计），单盘上限可选。
        </p>
      </div>
      <DataDiskEditor id={id} serverId={serverId} draft={draft} onChange={onChange} known={[known]} />
    </section>
  );
}

/**
 * A new bundle on one server: name, the quotas (empty = 不限; GPUs start at
 * none; the disk total must be filled in) and the data disks.
 */
export function BundleCreateDialog({ defaultServerId, onClose }: { defaultServerId: string; onClose: () => void }) {
  const serversQuery = useGrantServers();
  const invalidate = useInvalidateBundles();
  const [serverId, setServerIdState] = useState(defaultServerId);
  const [name, setName] = useState('');
  const [texts, setTexts] = useState<QuotaTexts>(NEW_BUNDLE_QUOTA_TEXTS);
  const [disks, setDisks] = useState<DataDiskDraft>([]);
  // Data disks are pools of one server: another server starts over.
  const setServerId = (next: string) => {
    if (next !== serverId) setDisks([]);
    setServerIdState(next);
  };
  const gpuEnabled = serversQuery.data?.find((server) => server.id === serverId)?.gpuEnabled;
  // A server without GPU passthrough has no cards to give: GPUs stay at none.
  const shownTexts = gpuEnabled === false ? { ...texts, gpuCount: '0' } : texts;
  const [error, setError] = useState<string | null>(null);
  const quotas = parseQuotaTexts(shownTexts);
  const dataDisks = parseDataDiskDraft(disks);
  const create = useMutation({
    mutationFn: (body: CreateGrantBundleRequest) => api.post<GrantBundleDto>('/admin/grant-bundles', body),
    onSuccess: () => {
      toast({ title: '授权模板已创建' });
      invalidate();
      onClose();
    },
    onError: (mutationError) => setError(bundleErrorText(mutationError)),
  });
  const ready = Boolean(serverId) && quotas !== undefined && dataDisks !== undefined && nameError(name) === null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>新建授权模板</DialogTitle>
          <DialogDescription>模板绑定一台服务器，定义额度、磁盘总额和数据盘；在用户的授权页分配，可逐项修改。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <SelectField
            id="grant-bundle-server"
            label="服务器"
            value={serverId}
            onChange={setServerId}
            options={(serversQuery.data ?? []).map((server): [string, string] => [server.id, server.name])}
            placeholder="选择服务器"
            loading={serversQuery.isLoading}
            emptyText="还没有服务器"
          />
          <NameField id="grant-bundle-name" value={name} onChange={(value) => { setName(value); setError(null); }} />
          <ServerProfilePanel serverId={serverId} />
          <BundleQuotaFields
            idPrefix="grant-bundle"
            texts={shownTexts}
            onChange={setTexts}
            gpuEnabled={gpuEnabled}
          />
          <BundleDataDisks id="grant-bundle-data-disks" serverId={serverId} draft={disks} onChange={setDisks} />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button
            onClick={() => { if (quotas && dataDisks) create.mutate({ serverId, name: name.trim(), ...quotas, dataDisks }); }}
            disabled={!ready || create.isPending}
          >
            {create.isPending ? '创建中...' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Edit a bundle: change the fields, preview who it affects, then save with
 * the revision the preview was made against. A stale revision reloads the
 * bundle and asks for a fresh preview.
 */
export function BundleEditDialog({ bundle, onClose }: { bundle: GrantBundleDto; onClose: () => void }) {
  const servers = useGrantServers().data ?? [];
  const invalidate = useInvalidateBundles();
  const [base, setBase] = useState(bundle);
  const [name, setName] = useState(bundle.name);
  const [texts, setTexts] = useState<QuotaTexts>(() => quotasToTexts(bundle));
  const [disks, setDisks] = useState<DataDiskDraft>(() => dataDiskDraftFrom(bundle.dataDisks));
  const [preview, setPreview] = useState<GrantBundlePreviewDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const changes = nameError(name) === null ? bundleChanges(base, name, texts, disks) : undefined;
  // Saving a list that drops disks some users hold volumes on lapses those volumes.
  const revokes = preview?.entries.some((entry) => entry.dataDisksRevoked.length > 0) ?? false;
  const changed = changes !== undefined && Object.keys(changes).length > 0;

  const runPreview = useMutation({
    mutationFn: () => api.post<GrantBundlePreviewDto>(`/admin/grant-bundles/${base.id}/preview`, changes),
    onSuccess: (result) => { setNotice(null); setPreview(result); },
    onError: (error) => setNotice(bundleErrorText(error)),
  });
  const save = useMutation({
    mutationFn: () => {
      const body: PatchGrantBundleRequest = { ...changes, expectedRevision: base.revision };
      return api.patch<GrantBundleDto>(`/admin/grant-bundles/${base.id}`, body);
    },
    onSuccess: () => {
      toast({ title: '授权模板已保存' });
      invalidate();
      onClose();
    },
    onError: (error) => {
      const current = apiErrorCurrent(error, FailureCode.RevisionConflict, isGrantBundleDto);
      if (error instanceof ApiError && error.code === FailureCode.RevisionConflict) {
        if (current) {
          // Keep what this administrator changed; take everything else from the newer revision.
          const rebased = rebaseBundleDraft(base, current, name, texts, disks);
          setBase(current);
          setName(rebased.name);
          setTexts(rebased.texts);
          setDisks(rebased.disks);
        }
        invalidate();
        setPreview(null);
        setNotice('模板已被他人修改，已载入最新版本。请检查后重新预览。');
        return;
      }
      setPreview(null);
      setNotice(bundleErrorText(error));
    },
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{preview ? `确认修改「${base.name}」` : `编辑「${base.name}」`}</DialogTitle>
          <DialogDescription>
            {serverName(base.serverId, servers)} · {base.grantCount} 个用户使用 · 未覆盖该字段的用户保存后立即生效
          </DialogDescription>
        </DialogHeader>
        {notice ? (
          <Alert variant="destructive"><AlertDescription>{notice}</AlertDescription></Alert>
        ) : null}
        {preview ? (
          <BundlePreview preview={preview} />
        ) : (
          <div className="space-y-3">
            <NameField id={`grant-bundle-${base.id}-name`} value={name} onChange={setName} />
            <ServerProfilePanel serverId={base.serverId} />
            <BundleQuotaFields
              idPrefix={`grant-bundle-${base.id}`}
              texts={texts}
              onChange={setTexts}
              gpuEnabled={servers.find((server) => server.id === base.serverId)?.gpuEnabled}
            />
            <BundleDataDisks
              id={`grant-bundle-${base.id}-data-disks`}
              serverId={base.serverId}
              draft={disks}
              onChange={setDisks}
              known={base.dataDisks}
            />
          </div>
        )}
        <DialogFooter>
          {preview ? (
            <>
              <Button variant="outline" onClick={() => setPreview(null)} disabled={save.isPending}>返回修改</Button>
              <Button
                variant={revokes ? 'destructive' : 'default'}
                onClick={() => save.mutate()}
                disabled={save.isPending}
                data-testid="grant-bundle-save"
              >
                {save.isPending ? '保存中...' : '确认保存'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>取消</Button>
              <Button
                onClick={() => runPreview.mutate()}
                disabled={!changed || runPreview.isPending}
                data-testid="grant-bundle-preview"
              >
                {runPreview.isPending ? '计算中...' : '预览影响'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
