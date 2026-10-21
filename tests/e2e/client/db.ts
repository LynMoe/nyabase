import { execFileSync } from 'node:child_process';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only uuids are ever interpolated into SQL, and only after this check. */
export function uuid(value: string): string {
  if (!UUID_RE.test(value)) throw new Error(`not a uuid: ${value}`);
  return value;
}

/** Runs one statement through psql against the run's database; returns tab-split rows. */
export function psql(databaseUrl: string, statement: string): string[][] {
  const output = execFileSync(
    'psql',
    [databaseUrl, '-X', '-q', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', statement],
    { encoding: 'utf8', timeout: 30_000 },
  );
  return output.split('\n').filter(Boolean).map((line) => line.split('\t'));
}
