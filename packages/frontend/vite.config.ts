import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-vite-plugin';
import path from 'path';

export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
  resolve: {
    alias: {
      '@nyabase/common': path.resolve(__dirname, '../common/src/index.ts'),
      // Compile-time web aliases; keep in sync with tsconfig.json and vitest.config.ts.
      '@nyabase/nvidia-gpu': path.resolve(__dirname, '../../extensions/nvidia-gpu/src/index.ts'),
      '@nyabase/nvidia-gpu-web': path.resolve(__dirname, '../../extensions/nvidia-gpu/src/web/index.ts'),
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Heavy/independent third-party deps go into their own chunks so the
        // entry chunk shrinks and chunks change independently of one another.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // Put pnpm's `.pnpm/<pkg>@<ver>/...` resolution in front so we still
          // match by package name regardless of nesting depth.
          if (id.includes('/recharts/') || id.includes('/d3-')) return 'recharts';
          if (id.includes('/@xterm/')) return 'xterm';
          if (id.includes('/lucide-react/')) return 'lucide';
          if (id.includes('/@radix-ui/')) return 'radix';
          if (id.includes('/@tanstack/')) return 'tanstack';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3001', ws: true, changeOrigin: true },
    },
  },
});
