import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Capability, type UserDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Button } from '../components/ui/button.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { ListSearch, matchesSearch } from '../components/layout/list-search.js';
import { userDeleting } from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from '../hooks/use-toast.js';
import { useAuthStore } from '../store/auth.js';
import { isPermanentQueryError, refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { CreateUserDialog } from './users-page/create-user-dialog.js';
import { UsersTable } from './users-page/users-table.js';

export default function UsersPage() {
  const currentUserId = useAuthStore((state) => state.user?.id);
  const canManageUsers = useAuthStore((state) => state.user?.capabilities.includes(Capability.ManageUsers) ?? false);
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteUser, setDeleteUser] = useState<UserDto | null>(null);
  const [query, setQuery] = useState('');
  const usersQuery = useQuery({
    queryKey: queryKeys.users.admin,
    queryFn: () => api.get<UserDto[]>('/users'),
    retry: (count, error) => !isPermanentQueryError(error) && count < 1,
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (users) => users.every((user) => !userDeleting(user.status)),
    }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`/users/${id}`),
    onSuccess: () => {
      toast({ title: '用户已删除' });
      setDeleteUser(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.admin });
    },
    onError: (error) => toast({ title: '删除用户失败', description: errorMessage(error), variant: 'destructive' }),
  });
  return (
    <Page testId="users-management">
      <PageHeader
        title="用户"
        description={
          usersQuery.data && usersQuery.data.length > 0
            ? `${usersQuery.data.length} 个用户`
            : undefined
        }
        actions={
          canManageUsers ? (
            <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建用户</Button>
          ) : undefined
        }
      />
      <QueryView
        query={usersQuery}
        resourceName="用户"
        loadingLabel="加载用户..."
        showEmpty={usersQuery.data?.length === 0}
        empty={
          <EmptyState
            title="暂无用户。"
            action={
              canManageUsers ? (
                <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建用户</Button>
              ) : undefined
            }
          />
        }
      >
        {(users) => {
          const visibleUsers = users.filter((user) => matchesSearch(query, [
            user.username,
            user.displayName,
            ...user.groups.map((group) => group.name),
          ]));
          return (
          <SectionCard
            flush
            toolbar={<ListSearch value={query} onChange={setQuery} placeholder="搜索用户名、显示名、用户组" />}
          >
            <UsersTable
              users={visibleUsers}
              canManage={canManageUsers}
              currentUserId={currentUserId}
              onDelete={setDeleteUser}
            />
          </SectionCard>
          );
        }}
      </QueryView>
      {canManageUsers && <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />}
      <ConfirmDialog
        open={Boolean(deleteUser)}
        title="删除用户？"
        description={`将永久删除用户「${deleteUser?.displayName}」。其登录会话会被终止，组关系与资源授权会一并清理，且不可恢复。`}
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={remove.isPending}
        onConfirm={() => { if (deleteUser) remove.mutate(deleteUser.id); }}
        onOpenChange={(open) => { if (!open) setDeleteUser(null); }}
      />
    </Page>
  );
}
