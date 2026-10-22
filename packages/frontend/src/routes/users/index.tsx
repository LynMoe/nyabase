import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-access.js';
import { ACCESS } from '../../lib/route-access.js';

export const Route = createFileRoute('/users/')({
  component: UsersRoute,
});

const LazyUsersPage = lazyRouteComponent(() => import('../../pages/users-page.js'));

function UsersRoute() {
  return (
    <RequireAccess rule={ACCESS.users}>
      <LazyUsersPage />
    </RequireAccess>
  );
}
