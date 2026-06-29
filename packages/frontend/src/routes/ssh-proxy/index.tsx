import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireAnyCapability } from '../../components/require-capability.js';

export const Route = createFileRoute('/ssh-proxy/')({
  component: SshProxyRoute,
});

const LazySshProxyPage = lazyRouteComponent(() => import('../../pages/ssh-proxy-page.js'));

function SshProxyRoute() {
  return (
    <RequireAnyCapability capabilities={[Capability.ViewMetricsAll, Capability.ManageSystemSettings]}>
      <LazySshProxyPage />
    </RequireAnyCapability>
  );
}
