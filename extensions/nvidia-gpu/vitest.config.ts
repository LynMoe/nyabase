import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'dist-esm/**', 'src/web/**'],
  },
  resolve: {
    alias: {
      '@nyabase/common': path.resolve(__dirname, '../../packages/common/src/index.ts'),
    },
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
});
