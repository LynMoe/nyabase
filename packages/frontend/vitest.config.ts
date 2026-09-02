import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@nyabase/common': path.resolve(__dirname, '../common/src/index.ts'),
      '@nyabase/nvidia-gpu': path.resolve(__dirname, '../../extensions/nvidia-gpu/src/index.ts'),
      '@nyabase/nvidia-gpu-web': path.resolve(__dirname, '../../extensions/nvidia-gpu/src/web/index.ts'),
      '@': path.resolve(__dirname, './src'),
    },
    extensionAlias: {
      '.js': ['.tsx', '.ts', '.js'],
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['dist/**', 'src/components/layout/**/*.test.tsx'],
        },
      },
      {
        extends: true,
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['src/components/layout/**/*.test.tsx'],
          exclude: ['dist/**'],
        },
      },
    ],
  },
});
