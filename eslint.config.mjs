import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.js'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: true,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      // A dropped promise loses its rejection: await it, return it, or `void` it on purpose.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    // These compile to CommonJS: tsc rewrites a reference to an exported binding of the
    // same file as `exports.NAME`, so a local named `exports` turns it into `undefined` in
    // dist while vitest (ESM) still passes. `require` breaks emitted dynamic imports the same way.
    files: ['packages/{backend,common,agent}/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: [
          'VariableDeclaration:not([declare=true]) > VariableDeclarator > Identifier.id',
          ':matches(FunctionDeclaration, ClassDeclaration) > Identifier.id',
          'CatchClause > Identifier.param',
          ':function > Identifier.params',
        ].map((binding) => `${binding}[name=/^(exports|require)$/]`).join(', '),
        message: 'Do not name a binding `exports` or `require`: the CommonJS output reads those names.',
      }],
    },
  },
];
