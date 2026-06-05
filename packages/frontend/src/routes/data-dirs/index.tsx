import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/data-dirs/')({
  component: lazyRouteComponent(() => import('../../pages/data-dirs-page.js')),
});
