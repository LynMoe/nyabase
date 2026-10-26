/**
 * Vitest global setup: the PostgreSQL suites skip themselves without
 * NYABASE_TEST_DATABASE_URL, so say so once instead of reporting a quiet pass.
 */
export default function warnWhenPostgresTestsSkip(): void {
  if (process.env.NYABASE_TEST_DATABASE_URL) return;
  console.warn(
    '\nNYABASE_TEST_DATABASE_URL is not set: the PostgreSQL integration suites are SKIPPED.\n'
      + 'Point it at a disposable PostgreSQL 18 server to run them (CI always does).\n',
  );
}
