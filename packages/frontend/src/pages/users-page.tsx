import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Role, type UserDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { ListSearch, matchesSearch } from '../components/layout/list-search.js';
import { userDeleting } from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { useHasRole } from '../lib/use-role.js';
import { isPermanentQueryError, refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { CreateUserDialog } from './users-page/create-user-dialog.js';
import { UsersTable } from './users-page/users-table.js';

export default function UsersPage() {
  const canManageUsers = useHasRole(Role.UserAdmin);
  const [createOpen, setCreateOpen] = useState(false);
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
            <UsersTable users={visibleUsers} allUsers={users} />
          </SectionCard>
          );
        }}
      </QueryView>
      {canManageUsers && <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />}
    </Page>
  );
}
