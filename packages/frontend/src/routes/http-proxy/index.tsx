import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/http-proxy/')({
  component: lazyRouteComponent(() => import('../../pages/http-proxy-page.js')),
});
