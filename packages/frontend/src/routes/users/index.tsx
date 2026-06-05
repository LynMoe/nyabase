import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../components/require-capability.js';

export const Route = createFileRoute('/users/')({
  component: UsersRoute,
});

const LazyUsersPage = lazyRouteComponent(() => import('../../pages/users-page.js'));

function UsersRoute() {
  return (
    <RequireCapability capability={Capability.ManageUsers}>
      <LazyUsersPage />
    </RequireCapability>
  );
}
