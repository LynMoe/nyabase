import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../components/require-capability.js';

export const Route = createFileRoute('/system-settings/')({
  component: SystemSettingsRoute,
});

const LazySystemSettingsPage = lazyRouteComponent(() => import('../../pages/system-settings-page.js'));

function SystemSettingsRoute() {
  return (
    <RequireCapability capability={Capability.ManageSystemSettings}>
      <LazySystemSettingsPage />
    </RequireCapability>
  );
}
