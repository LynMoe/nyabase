import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  GRANT_EXPIRY_GRACE_DAYS,
  type GroupDto,
  type ServerGrantDto,
  type SharedBackendGrantDto,
  type StoragePoolGrantDto,
  type UserDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
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
import { type GrantPanelData, type SubjectKind, useGrantPanelData } from './use-grant-panel-data.js';
import { BackendGrantDialog, PoolGrantDialog, ServerGrantDialog } from './grant-dialogs.js';
import { backendName, poolName } from './use-grant-panel-data.js';

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

export type CreateKind = 'server' | 'pool' | 'backend';

/** What the panel is currently asking the dialogs to do. */
export interface GrantDialogState {
  createKind: CreateKind | null;
  editServerGrant: ServerGrantDto | null;
  editPoolGrant: StoragePoolGrantDto | null;
  editBackendGrant: SharedBackendGrantDto | null;
}

export function useGrantDialogState() {
  const [createKind, setCreateKind] = useState<CreateKind | null>(null);
  const [editServerGrant, setEditServerGrant] = useState<ServerGrantDto | null>(null);
  const [editPoolGrant, setEditPoolGrant] = useState<StoragePoolGrantDto | null>(null);
  const [editBackendGrant, setEditBackendGrant] = useState<SharedBackendGrantDto | null>(null);
  return {
    state: { createKind, editServerGrant, editPoolGrant, editBackendGrant },
    setCreateKind,
    setEditServerGrant,
    setEditPoolGrant,
    setEditBackendGrant,
  };
}

type DialogHostProps = {
  data: GrantPanelData;
  dialogs: ReturnType<typeof useGrantDialogState>;
};

/** The add/edit dialogs for all three grant kinds; at most one is open. */
export function GrantDialogHost({ data, dialogs }: DialogHostProps) {
  const { state, setCreateKind, setEditServerGrant, setEditPoolGrant, setEditBackendGrant } = dialogs;
  const { serversQuery, poolsQuery, backendsQuery } = data.queries;
  const { prefix, servers, pools, backends } = data;
  const closeCreate = () => setCreateKind(null);
  const savedCreate = () => {
    closeCreate();
    data.invalidate();
  };
  const closeCreateOnDismiss = (open: boolean) => { if (!open) closeCreate(); };

  return (
    <>
      {state.createKind === 'server' ? (
        <ServerGrantDialog
          prefix={prefix}
          servers={data.ungrantedServers}
          choice={{
            loading: serversQuery.isLoading,
            error: serversQuery.isError,
            onRetry: () => { void serversQuery.refetch(); },
          }}
          onSaved={savedCreate}
          onOpenChange={closeCreateOnDismiss}
        />
      ) : null}

      {state.createKind === 'pool' ? (
        <PoolGrantDialog
          prefix={prefix}
          pools={data.grantablePools}
          servers={servers}
          hasServerGrants={data.grantedServerIds.size > 0}
          choice={{
            loading: serversQuery.isLoading || poolsQuery.isLoading,
            error: serversQuery.isError || poolsQuery.isError,
            onRetry: () => {
              void serversQuery.refetch();
              void poolsQuery.refetch();
            },
          }}
          onSaved={savedCreate}
          onOpenChange={closeCreateOnDismiss}
        />
      ) : null}

      {state.createKind === 'backend' ? (
        <BackendGrantDialog
          prefix={prefix}
          backends={data.ungrantedBackends}
          choice={{
            loading: backendsQuery.isLoading,
            error: backendsQuery.isError,
            onRetry: () => { void backendsQuery.refetch(); },
          }}
          onSaved={savedCreate}
          onOpenChange={closeCreateOnDismiss}
        />
      ) : null}

      {state.editServerGrant ? (
        <ServerGrantDialog
          grant={state.editServerGrant}
          servers={servers}
          prefix={prefix}
          onSaved={() => {
            setEditServerGrant(null);
            data.invalidate();
          }}
          onOpenChange={(open) => { if (!open) setEditServerGrant(null); }}
        />
      ) : null}

      {state.editPoolGrant ? (
        <PoolGrantDialog
          grant={state.editPoolGrant}
          title={poolName(state.editPoolGrant.poolId, pools, servers)}
          pools={pools}
          servers={servers}
          prefix={prefix}
          onSaved={() => {
            setEditPoolGrant(null);
            data.invalidate();
          }}
          onOpenChange={(open) => { if (!open) setEditPoolGrant(null); }}
        />
      ) : null}

      {state.editBackendGrant ? (
        <BackendGrantDialog
          grant={state.editBackendGrant}
          title={backendName(state.editBackendGrant.sharedBackendId, backends)}
          backends={backends}
          prefix={prefix}
          onSaved={() => {
            setEditBackendGrant(null);
            data.invalidate();
          }}
          onOpenChange={(open) => { if (!open) setEditBackendGrant(null); }}
        />
      ) : null}
    </>
  );
}
