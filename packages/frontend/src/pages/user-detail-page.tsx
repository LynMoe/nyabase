import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Capability, UserStatus, type UserDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { userDeleting } from '../lib/in-progress.js';
import { ResetPasswordDialog, UserIdentityDialog } from './user-detail-page/user-dialogs.js';
import { UserHeaderActions } from './user-detail-page/user-detail-tabs.js';
import { UserDetailTabs } from './user-detail-page/user-detail-tabs.js';
import { useUserMutations } from './user-detail-page/use-user-mutations.js';
import { queryKeys } from '../lib/query-keys.js';
import { refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { toast } from '../hooks/use-toast.js';
import { useAuthStore } from '../store/auth.js';
import { type UserDetailTab } from '../lib/detail-tabs.js';

const routeApi = getRouteApi('/users/$id');

export default function UserDetailPage() {
  const { id } = routeApi.useParams();
  const { tab } = routeApi.useSearch();
  const navigate = useNavigate({ from: '/users/$id' });
  const currentUserId = useAuthStore((state) => state.user?.id);
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const canManageUsers = capabilities.includes(Capability.ManageUsers);
  const canManageGrants = capabilities.includes(Capability.ManageGrants);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetSecret, setResetSecret] = useState<string | null>(null);

  const selectTab = (next: UserDetailTab) => {
    void navigate({ search: (prev) => ({ ...prev, tab: next }) });
  };

  const userQuery = useQuery({
    queryKey: queryKeys.users.detail(id),
    queryFn: () => api.get<UserDto>(`/users/${id}`),
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (loaded) => !userDeleting(loaded.status),
    }),
  });

  const { patchUser, remove } = useUserMutations({
    id,
    onDisabled: () => setDisableOpen(false),
    onIdentitySaved: () => setIdentityOpen(false),
    onDeleted: () => setDeleteOpen(false),
  });

  const user = userQuery.data;
  const isSelf = user?.id === currentUserId;
  const canOperate = canManageUsers && Boolean(user) && !isSelf;

  return (
    <Page testId="user-detail">
      <PageHeader
        title={user?.displayName ?? '用户'}
        description={user ? `@${user.username}` : undefined}
        crumbs={[
          { label: '用户', to: '/users' },
          { label: user?.displayName ?? '…' },
        ]}
        actions={
          canOperate && user ? (
            <UserHeaderActions
              user={user}
              patchPending={patchUser.isPending}
              onEnable={() => patchUser.mutate({ status: UserStatus.Active })}
              onDisable={() => setDisableOpen(true)}
              onReset={() => { setResetSecret(null); setResetOpen(true); }}
              onDelete={() => setDeleteOpen(true)}
            />
          ) : undefined
        }
      />
      <QueryView
        query={userQuery}
        resourceName="用户"
        loadingLabel="加载用户..."
        onBack={() => window.history.back()}
      >
        {(loaded) => (
          <UserDetailTabs
            tab={tab}
            user={loaded}
            canManageUsers={canManageUsers}
            canManageGrants={canManageGrants}
            onTab={selectTab}
            onEditIdentity={() => setIdentityOpen(true)}
          />
        )}
      </QueryView>
      {identityOpen && user ? (
        <UserIdentityDialog
          displayName={user.displayName}
          pending={patchUser.isPending}
          onSubmit={(next) => {
            if (!next) {
              toast({ title: '显示名称不能为空', variant: 'destructive' });
              return;
            }
            if (next === user.displayName) {
              toast({ title: '没有需要保存的更改' });
              return;
            }
            patchUser.mutate({ displayName: next });
          }}
          onOpenChange={(open) => { if (!open) setIdentityOpen(false); }}
        />
      ) : null}
      <ConfirmDialog
        open={disableOpen}
        title="停用用户？"
        description={`将停用「${user?.displayName}」。该账号将无法登录，已有会话会被终止。`}
        confirmLabel="确认停用"
        pendingLabel="处理中..."
        pending={patchUser.isPending}
        onConfirm={() => patchUser.mutate({ status: UserStatus.Disabled })}
        onOpenChange={setDisableOpen}
      />
      <ConfirmDialog
        open={deleteOpen}
        title="删除用户？"
        description={`将永久删除用户「${user?.displayName}」。其登录会话会被终止，组关系与资源授权会一并清理，且不可恢复。`}
        confirmLabel="确认删除"
        pendingLabel="确认删除"
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        onOpenChange={setDeleteOpen}
      />
      <ResetPasswordDialog
        open={resetOpen}
        secret={resetSecret}
        username={user?.username}
        displayName={user?.displayName}
        pending={patchUser.isPending}
        onReset={(password) => {
          patchUser.mutate(
            { password },
            {
              onSuccess: () => {
                toast({ title: '密码已重置' });
                setResetSecret(password);
                setResetOpen(false);
              },
            },
          );
        }}
        onClose={() => { setResetOpen(false); setResetSecret(null); }}
      />
    </Page>
  );
}
