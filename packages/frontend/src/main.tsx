import './index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { Toaster } from './components/ui/toaster.js';
import { ErrorBoundary } from './components/error-boundary.js';
import { ThemeApplier } from './components/theme-applier.js';
import { queryClient } from './lib/query-client.js';
import { initializeAuthSync } from './lib/auth-session.js';
import { createNvidiaGpuWebExtension, nvidiaGpuFormatError } from '@nyabase/nvidia-gpu-web';
import { frontendExtensionHost } from './extensions/host.js';
import {
  registerExtensionErrorFormatters,
  registerServerCardExtensions,
} from './extensions/registry.js';

initializeAuthSync();
// Compile-time composition: also register the package in
// packages/backend/src/app.module.ts and packages/node-exporter/src/main.ts.
registerExtensionErrorFormatters([nvidiaGpuFormatError]);
registerServerCardExtensions([
  createNvidiaGpuWebExtension(frontendExtensionHost as never) as never,
]);

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary scope="Root">
      <ThemeApplier />
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
