import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**'],
    // Nest decorators and emitted constructor metadata require this before imports.
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
