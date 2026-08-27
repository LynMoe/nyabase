import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAnyCapability } from '../../components/require-capability.js';
import { HTTP_PROXY_STATUS_CAPABILITIES } from '../../lib/http-proxy-access.js';

export const Route = createFileRoute('/http-proxy-ops/')({
  component: HttpProxyOpsRoute,
});

const LazyHttpProxyOpsPage = lazyRouteComponent(() => import('../../pages/http-proxy-ops-page.js'));

function HttpProxyOpsRoute() {
  return (
    <RequireAnyCapability capabilities={HTTP_PROXY_STATUS_CAPABILITIES}>
      <LazyHttpProxyOpsPage />
    </RequireAnyCapability>
  );
}
