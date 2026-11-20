import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { SharedBackendGrantDto } from '@nyabase/common';
import { useActionMutation } from '../../hooks/use-action-mutation.js';
import { api } from '../../lib/api.js';
import { formatGrantBytes } from '../../lib/grant-quota.js';
import { formatBytes } from '../../lib/utils.js';
import { SelectField } from '../layout/form-field.js';
import { SectionCard } from '../layout/section-card.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Hint } from '../ui/hint.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';
import { GrantExpiryInput, NumberField, PhaseBadge } from './grant-form-parts.js';
import {
  backendDisplayName,
  backendName,
  expiryLabel,
  expiryPhase,
  gibHint,
  initialExpiry,
  isoOrNull,
  gibQuotaText,
  parseGibLimit,
  useBackendAccess,
  useBackendGrants,
  useGrantBackends,
  useInvalidateGrants,
} from './use-grant-panel-data.js';

/** A shared-backend grant picked for deletion. */
export interface BackendDeleteTarget {
  backendId: string;
  label: string;
}

/** The user's shared-storage (CephFS) grants: a quota and an expiry per backend. */
export function BackendGrantsCard({
  userId,
  onDelete,
}: {
  userId: string;
  onDelete: (target: BackendDeleteTarget) => void;
}) {
  const backendsQuery = useGrantBackends();
  const backends = backendsQuery.data ?? [];
  const grants = useBackendGrants(userId).data ?? [];
  const [dialog, setDialog] = useState<'add' | SharedBackendGrantDto | null>(null);
  const grantedIds = new Set(grants.map((row) => row.sharedBackendId));
  const blocked = !backendsQuery.isSuccess
    ? null
    : backends.length === 0
      ? '还没有登记共享存储。'
      : backends.every((backend) => grantedIds.has(backend.id)) ? '所有共享存储都已授权。' : null;
  return (
    <SectionCard
      title="共享存储授权"
      actions={(
        <Hint content={blocked} disabled={blocked !== null}>
          <Button size="sm" onClick={() => setDialog('add')} disabled={blocked !== null} data-testid="grant-add-backend">
            <Plus className="h-4 w-4" />授权
          </Button>
        </Hint>
      )}
      flush={grants.length > 0}
      testId="grant-backends"
    >
      {grants.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无共享存储授权。</p>
      ) : (
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              <TableHead>共享存储</TableHead>
              <TableHead>额度</TableHead>
              <TableHead>已有数据</TableHead>
              <TableHead>到期</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.map((grant) => (
              <TableRow key={grant.id}>
                <TableCell className="whitespace-normal">
                  <ResourceRef
                    kind="shared-backend"
                    id={grant.sharedBackendId}
                    name={backendDisplayName(grant.sharedBackendId, backends)}
                  />
                </TableCell>
                <TableCell>{formatGrantBytes(grant.limitBytes)}</TableCell>
                <TableCell><BackendUsedBytes userId={userId} backendId={grant.sharedBackendId} /></TableCell>
                <TableCell>{expiryLabel(grant.expiresAt)}</TableCell>
                <TableCell><PhaseBadge phase={expiryPhase(grant.expiresAt)} /></TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setDialog(grant)}>编辑</Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onDelete({
                        backendId: grant.sharedBackendId,
                        label: `${backendName(grant.sharedBackendId, backends)} · ${formatGrantBytes(grant.limitBytes)}`,
                      })}
                    >
                      删除
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {dialog ? (
        <BackendGrantDialog
          userId={userId}
          grant={dialog === 'add' ? undefined : dialog}
          grantedIds={grantedIds}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </SectionCard>
  );
}

/** The data on the user's volume on the backend, while the grant is current. */
function BackendUsedBytes({ userId, backendId }: { userId: string; backendId: string }) {
  const access = useBackendAccess(userId, backendId);
  return <>{access ? formatBytes(access.usedBytes) : '—'}</>;
}

/** Add (no `grant`) or edit one shared storage grant of the user. */
function BackendGrantDialog({
  userId,
  grant,
  grantedIds,
  onClose,
}: {
  userId: string;
  grant?: SharedBackendGrantDto;
  grantedIds: ReadonlySet<string>;
  onClose: () => void;
}) {
  const backendsQuery = useGrantBackends();
  const invalidate = useInvalidateGrants(userId);
  const allBackends = backendsQuery.data ?? [];
  const [backendId, setBackendId] = useState(grant?.sharedBackendId ?? '');
  const [limitGib, setLimitGib] = useState(() => gibQuotaText(grant?.limitBytes));
  const [expiresAt, setExpiresAt] = useState(() => initialExpiry(grant?.expiresAt));
  const idPrefix = grant ? `grant-backend-${grant.sharedBackendId}` : 'grant-backend';
  const parsedLimit = parseGibLimit(limitGib, grant?.limitBytes);
  const save = useActionMutation({
    mutationFn: () => api.put<SharedBackendGrantDto>(`/users/${userId}/shared-backend-grants/${backendId}`, {
      limitBytes: parsedLimit!,
      expiresAt: isoOrNull(expiresAt),
    }),
    successTitle: '共享存储授权已保存',
    errorTitle: '共享存储授权保存失败',
    onSuccess: () => { onClose(); invalidate(); },
  });
  const options = allBackends
    .filter((backend) => !grantedIds.has(backend.id))
    .map((backend): [string, string] => [backend.id, backend.displayName ?? backend.name]);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {grant ? `编辑「${backendName(grant.sharedBackendId, allBackends)}」的共享存储授权` : '添加共享存储授权'}
          </DialogTitle>
          <DialogDescription>
            共享存储启用后，该用户在上面有一个共享卷，挂载到他在所有服务器上的容器；额度是这个卷能写入的数据上限。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {grant ? null : (
            <SelectField
              id={`${idPrefix}-target`}
              label="共享存储"
              value={backendId}
              onChange={setBackendId}
              options={options}
              placeholder="选择共享存储"
              loading={backendsQuery.isLoading}
              emptyText="没有可添加的共享存储"
            />
          )}
          <NumberField
            id={`${idPrefix}-limit`}
            label="额度（GiB）"
            value={limitGib}
            onChange={setLimitGib}
            hint={gibHint(limitGib)}
            error={limitGib.trim() && parsedLimit === undefined ? '请输入大于 0 的数值' : undefined}
          />
          <GrantExpiryInput id={`${idPrefix}-expires-at`} value={expiresAt} onChange={setExpiresAt} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => save.mutate()} disabled={!backendId || parsedLimit === undefined || save.isPending}>
            {save.isPending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
