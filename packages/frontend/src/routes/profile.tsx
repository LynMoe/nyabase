import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/profile')({
  component: lazyRouteComponent(() => import('../pages/profile-page.js')),
});
