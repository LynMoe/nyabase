import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { GRANT_EXPIRY_GRACE_DAYS, type GroupDto, type UserDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { toast } from '../../hooks/use-toast.js';
import { ConfirmDialog } from '../layout/confirm-dialog.js';
import { isQueryLoading } from '../layout/query-view.js';
import { QueryErrorState, QueryLoadingState } from '../query-state.js';
import {
  BackendGrantsCard,
  GraceCard,
  PoolGrantsCard,
  ServerGrantsCard,
  type DeleteTarget,
} from './grant-cards.js';
import { GrantDialogHost, useGrantDialogState } from './grant-dialog-host.js';
import { useGrantPanelData, type SubjectKind } from './use-grant-panel-data.js';

type Subject = UserDto | GroupDto;

/** All grants of one user or group (servers, storage pools, shared storage) with add/edit/delete. */
export function CanonicalGrantPanel({ subject, kind }: { subject: Subject; kind: SubjectKind }) {
  const data = useGrantPanelData(kind, subject.id);
  const dialogs = useGrantDialogState();
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const remove = useMutation({
    mutationFn: ({ resource, id }: DeleteTarget) =>
      api.delete<void>(`${data.prefix}/${resource}/${id}`),
    onSuccess: () => {
      toast({ title: '授权已删除' });
      setDeleteTarget(null);
      data.invalidate();
    },
    onError: (error) => toast({ title: '删除授权失败', description: errorMessage(error), variant: 'destructive' }),
  });

  if (data.grantLists.some(isQueryLoading)) {
    return (
      <div data-testid="canonical-grants">
        <QueryLoadingState label="加载授权..." />
      </div>
    );
  }
  const failedList = data.grantLists.find((query) => query.isError && query.data === undefined);
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
      <GraceCard lapsed={data.lapsedServers} servers={data.servers} />
      <ServerGrantsCard
        grants={data.serverGrants}
        servers={data.servers}
        blocked={data.serverBlocked}
        onAdd={() => dialogs.setCreateKind('server')}
        onEdit={dialogs.setEditServerGrant}
        onDelete={setDeleteTarget}
      />
      <PoolGrantsCard
        grants={data.poolGrants}
        pools={data.pools}
        servers={data.servers}
        grantedServerIds={data.grantedServerIds}
        blocked={data.poolBlocked}
        onAdd={() => dialogs.setCreateKind('pool')}
        onEdit={dialogs.setEditPoolGrant}
        onDelete={setDeleteTarget}
      />
      <BackendGrantsCard
        grants={data.backendGrants}
        backends={data.backends}
        blocked={data.backendBlocked}
        onAdd={() => dialogs.setCreateKind('backend')}
        onEdit={dialogs.setEditBackendGrant}
        onDelete={setDeleteTarget}
      />
      <GrantDialogHost data={data} dialogs={dialogs} />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除授权？"
        description={`将删除「${deleteTarget?.label}」。若删除后${kind === 'groups' ? '组内成员' : '该用户'}在该资源上不再被任何授权覆盖，将立即进入 ${GRANT_EXPIRY_GRACE_DAYS} 天宽限期（正在运行的容器会被停止），期满后其在该资源上的容器与数据卷将被清除。`}
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
