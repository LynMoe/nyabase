import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { GRANT_EXPIRY_GRACE_DAYS, type GroupDto, type UserDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { grantSubjectPath } from '../../lib/scoped-paths.js';
import { toast } from '../../hooks/use-toast.js';
import { ConfirmDialog } from '../layout/confirm-dialog.js';
import { isQueryLoading } from '../layout/query-view.js';
import { QueryErrorState, QueryLoadingState } from '../query-state.js';
import {
  BackendGrantsCard,
  type DeleteTarget,
  GraceCard,
  PoolGrantsCard,
  ServerGrantsCard,
} from './grant-cards.js';
import {
  type GrantSubject,
  type SubjectKind,
  useInvalidateGrants,
  useSubjectGrants,
} from './use-grant-panel-data.js';

/** All grants of one user or group (servers, storage pools, shared storage) with add/edit/delete. */
export function CanonicalGrantPanel({ subject, kind }: { subject: UserDto | GroupDto; kind: SubjectKind }) {
  const grantSubject: GrantSubject = { kind, id: subject.id };
  const grantLists = [
    useSubjectGrants(grantSubject, 'servers'),
    useSubjectGrants(grantSubject, 'pools'),
    useSubjectGrants(grantSubject, 'backends'),
  ];
  const invalidate = useInvalidateGrants(grantSubject);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const remove = useMutation({
    mutationFn: ({ resource, id }: DeleteTarget) =>
      api.delete<void>(`${grantSubjectPath(kind, subject.id)}/${resource}/${id}`),
    onSuccess: () => {
      toast({ title: '授权已删除' });
      setDeleteTarget(null);
      invalidate();
    },
    onError: (error) => toast({ title: '删除授权失败', description: errorMessage(error), variant: 'destructive' }),
  });

  if (grantLists.some(isQueryLoading)) {
    return (
      <div data-testid="canonical-grants">
        <QueryLoadingState label="加载授权..." />
      </div>
    );
  }
  const failedList = grantLists.find((query) => query.isError && query.data === undefined);
  if (failedList) {
    return (
      <div data-testid="canonical-grants">
        <QueryErrorState
          error={failedList.error}
          resourceName="授权"
          onRetry={() => { void failedList.refetch(); }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="canonical-grants">
      <GraceCard subject={grantSubject} />
      <ServerGrantsCard subject={grantSubject} onDelete={setDeleteTarget} />
      <PoolGrantsCard subject={grantSubject} onDelete={setDeleteTarget} />
      <BackendGrantsCard subject={grantSubject} onDelete={setDeleteTarget} />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除授权？"
        description={`将删除「${deleteTarget?.label}」。${lapseConsequence(deleteTarget?.resource)}`}
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={remove.isPending}
        onConfirm={() => {
          if (deleteTarget) remove.mutate(deleteTarget);
        }}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      />
    </div>
  );
}

/** What a lapse does on each kind of resource: servers stop and purge, pools and backends only lose volumes. */
function lapseConsequence(resource: DeleteTarget['resource'] | undefined): string {
  if (resource === 'server-grants') {
    return `无其他授权覆盖时，容器立即停止，${GRANT_EXPIRY_GRACE_DAYS} 天后清除。`;
  }
  return `无其他授权覆盖时，数据卷立即卸载，${GRANT_EXPIRY_GRACE_DAYS} 天后删除。`;
}
