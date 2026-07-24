/**
 * TypeORM migration discovery is an executable-code boundary. Tests live next
 * to migrations and are compiled into dist, so a broad `*.js` glob would load
 * Vitest modules during production bootstrap. Official migrations always use
 * the timestamped `<digits>-<name>` convention.
 */
export function migrationGlobs(moduleDir: string): string[] {
  return moduleDir.includes('/dist/')
    ? ['dist/database/migrations/[0-9]*-*.js']
    : ['src/database/migrations/[0-9]*-*.ts'];
}
