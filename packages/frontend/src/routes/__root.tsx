import { createRootRouteWithContext, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../store/auth.js';
import { AppLayout } from '../components/layout/app-layout.js';
import { ErrorBoundary } from '../components/error-boundary.js';
import { bootstrapAuthSession } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { sanitizeInternalRedirect } from '../lib/internal-redirect.js';
import { terminateBrowserSession } from '../lib/session-termination.js';

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
      navigate({
        to: '/login',
        search: { redirect: sanitizeInternalRedirect(locationHref), reason: undefined },
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

  if (status === 'checking') {
    return <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">正在验证会话...</div>;
  }

  if (status === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-3">
          <h1 className="text-lg font-semibold">无法验证会话</h1>
          <p className="text-sm text-muted-foreground">{authError ?? '请检查网络后重试。'}</p>
          <div className="flex justify-center gap-2">
            <Button variant="outline" onClick={() => { void terminateBrowserSession(); }}>退出登录</Button>
            <Button disabled={retrying} onClick={() => {
              setRetrying(true);
              void bootstrapAuthSession().finally(() => setRetrying(false));
            }}>
              {retrying ? '重试中...' : '重试'}
            </Button>
          </div>
        </div>
      </div>
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

export const Route = createRootRouteWithContext<RouterContext>()({ component: Root });
