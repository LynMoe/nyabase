import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-access.js';
import { ACCESS } from '../../lib/route-access.js';

export const Route = createFileRoute('/grant-bundles/')({
  component: GrantBundlesRoute,
});

const LazyGrantBundlesPage = lazyRouteComponent(() => import('../../pages/grant-bundles-page.js'));

function GrantBundlesRoute() {
  return (
    <RequireAccess rule={ACCESS.grantBundles}>
      <LazyGrantBundlesPage />
    </RequireAccess>
  );
}
