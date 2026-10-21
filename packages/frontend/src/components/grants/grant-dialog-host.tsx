import { useState } from 'react';
import type {
  ServerGrantDto,
  SharedBackendGrantDto,
  StoragePoolGrantDto,
} from '@nyabase/common';
import { BackendGrantDialog, PoolGrantDialog, ServerGrantDialog } from './grant-dialogs.js';
import { backendName, poolName } from './grant-format.js';
import type { GrantPanelData } from './use-grant-panel-data.js';

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
