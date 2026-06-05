import { createRootRouteWithContext, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useAuthStore } from '../store/auth.js';
import { AppLayout } from '../components/layout/app-layout.js';
import { ErrorBoundary } from '../components/error-boundary.js';

interface RouterContext {
  queryClient: QueryClient;
}

function Root() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    if (!user && pathname !== '/login') {
      navigate({ to: '/login', replace: true });
    }
  }, [user, pathname, navigate]);

  // Prevent flash of dashboard content before redirect
  if (!user && pathname !== '/login') return null;

  if (!user) {
    return (
      <ErrorBoundary scope="RouterShell">
        <Outlet />
      </ErrorBoundary>
    );
  }

  return (
    <AppLayout>
      <ErrorBoundary scope="RouteContent" key={pathname}>
        <Outlet />
      </ErrorBoundary>
    </AppLayout>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({ component: Root });
