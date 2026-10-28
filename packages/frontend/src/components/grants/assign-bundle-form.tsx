import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FailureCode, type GrantBundleDto, type PutServerGrantRequest, type ServerGrantDto } from '@nyabase/common';
import { ApiError, apiErrorDetails, errorMessage } from '../../lib/api-error.js';
import { api } from '../../lib/api.js';
import {
  bundleOptionGroups,
  type OverrideDraft,
  overrideDraftFrom,
  parseOverrideDraft,
} from '../../lib/grant-bundle-form.js';
import { toast } from '../../hooks/use-toast.js';
import { ConfirmDialog } from '../layout/confirm-dialog.js';
import { SelectField } from '../layout/form-field.js';
import { SectionCard } from '../layout/section-card.js';
import { Button } from '../ui/button.js';
import { GrantExpiryInput, OverrideQuotaFields } from './grant-form-parts.js';
import {
  isoOrNull,
  serverName,
  useGrantBundles,
  useGrantServers,
  useInvalidateGrants,
} from './use-grant-panel-data.js';

/** The grant the user already holds on the chosen bundle's server, awaiting「替换」. */
interface ReplacePrompt {
  serverName: string;
  currentBundleName: string;
  nextBundleName: string;
}

/**
 * Give the user a bundle: pick it (grouped by server), keep or
 * override each of its quotas, set the expiry. A user holds one bundle per
 * server, so assigning onto a server they already have asks before replacing.
 */
export function AssignBundleCard({ userId, grants }: { userId: string; grants: ServerGrantDto[] }) {
  const bundlesQuery = useGrantBundles();
  const servers = useGrantServers().data ?? [];
  const invalidate = useInvalidateGrants(userId);
  const [bundleId, setBundleId] = useState('');
  const [draft, setDraft] = useState<OverrideDraft>(() => overrideDraftFrom());
  const [expiresAt, setExpiresAt] = useState('');
  const [replacePrompt, setReplacePrompt] = useState<ReplacePrompt | null>(null);
  const bundles = bundlesQuery.data ?? [];
  const bundle = bundles.find((row) => row.id === bundleId);
  const existing = bundle ? grants.find((grant) => grant.serverId === bundle.serverId) : undefined;
  const overrides = parseOverrideDraft(draft, { bundle });
  const gpuEnabled = bundle ? servers.find((server) => server.id === bundle.serverId)?.gpuEnabled : undefined;
  // Overrides are relative to one bundle (and server): picking another starts over.
  const pickBundle = (next: string) => {
    if (next === bundleId) return;
    setBundleId(next);
    setDraft(overrideDraftFrom());
  };

  const reset = () => {
    setBundleId('');
    setDraft(overrideDraftFrom());
    setExpiresAt('');
  };
  const assign = useMutation({
    mutationFn: ({ target, replace }: { target: GrantBundleDto; replace: boolean }) => {
      const body: PutServerGrantRequest = {
        bundleId: target.id,
        overrides: overrides ?? {},
        expiresAt: isoOrNull(expiresAt),
        replace,
      };
      return api.put<ServerGrantDto>(`/users/${userId}/server-grants/${target.serverId}`, body);
    },
    onSuccess: (_grant, { replace }) => {
      toast({ title: replace ? '授权模板已替换' : '授权已添加' });
      setReplacePrompt(null);
      reset();
      invalidate();
    },
    onError: (error, { target }) => {
      if (error instanceof ApiError && error.code === FailureCode.ServerGrantExists) {
        const currentId = apiErrorDetails(error)?.bundleId;
        const current = bundles.find((row) => row.id === currentId)?.name ?? existing?.bundleName ?? '其他模板';
        setReplacePrompt({
          serverName: serverName(target.serverId, servers),
          currentBundleName: current,
          nextBundleName: target.name,
        });
        return;
      }
      setReplacePrompt(null);
      toast({ title: '授权失败', description: errorMessage(error), variant: 'destructive' });
    },
  });

  const noBundles = bundlesQuery.isSuccess && bundles.length === 0;
  return (
    <SectionCard
      title="分配授权模板"
      description="每台服务器上一个用户只能有一个授权模板；数据盘在下方服务器授权的详情里添加。"
      testId="grant-assign"
    >
      {noBundles ? (
        <p className="text-sm text-muted-foreground">
          还没有授权模板，请先到
          <Link to="/grant-bundles" className="mx-1 underline">授权模板</Link>
          新建。
        </p>
      ) : (
        <div className="space-y-4">
          <SelectField
            id="grant-assign-bundle"
            label="授权模板"
            value={bundleId}
            onChange={pickBundle}
            options={bundleOptionGroups(bundles, (id) => serverName(id, servers))}
            placeholder="选择授权模板"
            loading={bundlesQuery.isLoading}
            hint={existing
              ? `该用户在 ${serverName(existing.serverId, servers)} 上已有授权模板「${existing.bundleName}」，提交时将确认是否替换。`
              : bundle ? `服务器：${serverName(bundle.serverId, servers)}` : undefined}
          />
          {bundle ? (
            <>
              <OverrideQuotaFields
                idPrefix="grant-assign"
                bundle={bundle}
                draft={draft}
                onChange={setDraft}
                gpuEnabled={gpuEnabled}
              />
              <GrantExpiryInput id="grant-assign-expires-at" value={expiresAt} onChange={setExpiresAt} />
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={reset} disabled={assign.isPending}>清空</Button>
                <Button
                  onClick={() => assign.mutate({ target: bundle, replace: false })}
                  disabled={overrides === undefined || assign.isPending}
                  data-testid="grant-assign-submit"
                >
                  {assign.isPending ? '提交中...' : '分配'}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      )}
      <ConfirmDialog
        open={replacePrompt !== null}
        title="替换授权模板？"
        description={replacePrompt
          ? `该用户在 ${replacePrompt.serverName} 上已有授权模板「${replacePrompt.currentBundleName}」，是否替换为「${replacePrompt.nextBundleName}」？替换后立即生效，已有的数据盘额度保留。`
          : ''}
        confirmLabel="替换"
        pendingLabel="替换中..."
        confirmVariant="default"
        pending={assign.isPending}
        onConfirm={() => { if (bundle) assign.mutate({ target: bundle, replace: true }); }}
        onOpenChange={(open) => { if (!open) setReplacePrompt(null); }}
      />
    </SectionCard>
  );
}
