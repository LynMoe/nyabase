import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'dist-esm/**'],
  },
  resolve: {
    // Force `@nyabase/common` to resolve to the live TS sources during tests,
    // bypassing the `dist`/`dist-esm` build artifacts published via package.exports.
    alias: {
      '@nyabase/common': path.resolve(__dirname, 'src/index.ts'),
    },
    // Resolve TypeScript .ts files when the import uses .js extension
    // (TypeScript ESM convention: `import './foo.js'` → loads `./foo.ts`).
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
});
