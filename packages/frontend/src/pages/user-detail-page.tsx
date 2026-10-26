import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Role, type UserDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { userDeleting } from '../lib/in-progress.js';
import { UserHeaderActions } from './user-detail-page/user-detail-tabs.js';
import { UserDetailTabs } from './user-detail-page/user-detail-tabs.js';
import { queryKeys } from '../lib/query-keys.js';
import { refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { useAuthStore } from '../store/auth.js';
import { useHasRole } from '../lib/use-role.js';

const routeApi = getRouteApi('/users/$id');

export default function UserDetailPage() {
  const { id } = routeApi.useParams();
  const { tab } = routeApi.useSearch();
  const navigate = useNavigate({ from: '/users/$id' });
  const currentUserId = useAuthStore((state) => state.user?.id);
  const canManageUsers = useHasRole(Role.UserAdmin);
  const userQuery = useQuery({
    queryKey: queryKeys.users.detail(id),
    queryFn: () => api.get<UserDto>(`/users/${id}`),
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (loaded) => !userDeleting(loaded.status),
    }),
  });
  const user = userQuery.data;
  const canOperate = canManageUsers && Boolean(user) && user?.id !== currentUserId;

  return (
    <Page testId="user-detail">
      <PageHeader
        title={user?.displayName ?? '用户'}
        description={user ? `@${user.username}` : undefined}
        crumbs={[
          { label: '用户', to: '/users' },
          { label: user?.displayName ?? '…' },
        ]}
        actions={canOperate && user ? <UserHeaderActions user={user} /> : undefined}
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
            onTab={(next) => { void navigate({ search: (prev) => ({ ...prev, tab: next }) }); }}
          />
        )}
      </QueryView>
    </Page>
  );
}
