import { createRootRouteWithContext, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../store/auth.js';
import { AppLayout } from '../components/layout/app-layout.js';
import { ErrorBoundary } from '../components/error-boundary.js';
import { bootstrapAuthSession } from '../lib/api.js';
import { SessionCheckScreen } from '../components/layout/session-check-screen.js';
import { sanitizeInternalRedirect, takePendingLoginReason } from '../lib/auth-session.js';
import { DocumentTitle } from '../hooks/use-document-title.js';
import { NotFound } from '../components/not-found.js';

interface RouterContext {
  queryClient: QueryClient;
}

function Root() {
  const { user, status, authError } = useAuthStore();
  const [retrying, setRetrying] = useState(false);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const locationHref = useRouterState({ select: (s) => s.location.href });

  useEffect(() => {
    if (status === 'anonymous' && pathname !== '/login') {
      const reason = takePendingLoginReason();
      navigate({
        to: '/login',
        search: { redirect: sanitizeInternalRedirect(locationHref), reason },
        replace: true,
      });
    }
  }, [status, pathname, locationHref, navigate]);

  useEffect(() => {
    void bootstrapAuthSession();
    const syncOnFocus = () => { void bootstrapAuthSession(); };
    window.addEventListener('focus', syncOnFocus);
    return () => window.removeEventListener('focus', syncOnFocus);
  }, []);

  const retry = () => {
    setRetrying(true);
    void bootstrapAuthSession().finally(() => setRetrying(false));
  };

  if (status === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        <DocumentTitle title="正在验证会话" />
        正在验证会话...
      </div>
    );
  }

  if (status === 'throttled') {
    // The session is intact: focusing the tab or retrying after the wait loads
    // it normally. Signing out stays available (/login is hidden meanwhile).
    return (
      <SessionCheckScreen
        title="会话刷新繁忙"
        message={authError ?? '请稍后重试。'}
        retrying={retrying}
        onRetry={retry}
      />
    );
  }

  if (status === 'error') {
    return (
      <SessionCheckScreen
        title="无法验证会话"
        message={authError ?? '请检查网络后重试。'}
        retrying={retrying}
        onRetry={retry}
      />
    );
  }

  // Prevent flash of dashboard content before redirect
  if (status === 'anonymous' && pathname !== '/login') return null;

  if (status === 'anonymous' || !user) {
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

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
  notFoundComponent: NotFound,
});
