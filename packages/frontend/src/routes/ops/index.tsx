import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { ADMIN_INTENT_CAPABILITIES } from '@nyabase/common';
import { RequireAnyCapability } from '../../components/require-capability.js';

export const Route = createFileRoute('/ops/')({
  component: OpsRoute,
});

const LazyOpsPage = lazyRouteComponent(() => import('../../pages/ops-page.js'));

function OpsRoute() {
  return (
    <RequireAnyCapability capabilities={ADMIN_INTENT_CAPABILITIES}>
      <LazyOpsPage />
    </RequireAnyCapability>
  );
}
