import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**'],
    // reflect-metadata must be loaded before any TypeORM-decorated entity is imported.
    setupFiles: ['reflect-metadata'],
  },
  resolve: {
    alias: {
      '@nyabase/common': resolve(__dirname, '../common/src/index.ts'),
    },
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
});
