import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-access.js';
import { ACCESS } from '../../lib/route-access.js';

export const Route = createFileRoute('/users/$id')({
  component: UserDetailRoute,
});

const LazyUserDetailPage = lazyRouteComponent(() => import('../../pages/user-detail-page.js'));

function UserDetailRoute() {
  return (
    <RequireAccess rule={ACCESS.users}>
      <LazyUserDetailPage />
    </RequireAccess>
  );
}
