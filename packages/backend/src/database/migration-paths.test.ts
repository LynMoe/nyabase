import { describe, expect, it } from 'vitest';
import { migrationGlobs } from './migration-paths.js';

describe('migrationGlobs', () => {
  it('discovers only timestamped migration sources in source and compiled layouts', () => {
    expect(migrationGlobs('/repo/packages/backend/src/database')).toEqual([
      'src/database/migrations/[0-9]*-*.ts',
    ]);
    expect(migrationGlobs('/repo/packages/backend/dist/database')).toEqual([
      'dist/database/migrations/[0-9]*-*.js',
    ]);
    for (const pattern of migrationGlobs('/repo/packages/backend/dist/database')) {
      expect(pattern).not.toBe('dist/database/migrations/*.js');
      expect(pattern).not.toContain('*.test.js');
    }
  });
});
