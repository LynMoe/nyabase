import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-access.js';
import { ACCESS } from '../../lib/route-access.js';

export const Route = createFileRoute('/system-settings/')({
  component: SystemSettingsRoute,
});

const LazySystemSettingsPage = lazyRouteComponent(() => import('../../pages/system-settings-page.js'));

function SystemSettingsRoute() {
  return (
    <RequireAccess rule={ACCESS.systemSettings}>
      <LazySystemSettingsPage />
    </RequireAccess>
  );
}
