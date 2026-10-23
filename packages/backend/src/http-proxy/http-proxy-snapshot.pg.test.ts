import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { certificateFields } from './http-proxy-certificates.js';
import type { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { HttpProxySnapshotService } from './http-proxy-snapshot.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('HttpProxySnapshotService (PostgreSQL)', () => {
  it('builds snapshots on a freshly migrated database and advances the generation', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const config = { keyEncryptionSecret: () => 'k'.repeat(32) } as unknown as NyabaseConfigService;
      const service = new HttpProxySnapshotService(new PgTransactionManager(database), config);

      const first = await service.buildSnapshot();
      const second = await service.buildSnapshot();

      expect(first.generation).toBe(1);
      expect(first.routes).toEqual([]);
      expect(second.generation).toBe(2);
      const state = await database
        .selectFrom('interaction.http_proxy_snapshot_state')
        .select('generation')
        .executeTakeFirstOrThrow();
      expect(Number(state.generation)).toBe(2);
    });
  });

  it('drops only the pool whose TLS key no longer decrypts', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const secret = 'k'.repeat(32);
      const config = { keyEncryptionSecret: () => secret } as unknown as NyabaseConfigService;
      const service = new HttpProxySnapshotService(new PgTransactionManager(database), config);
      const dir = mkdtempSync(join(tmpdir(), 'nyabase-snapshot-'));
      try {
        const pool = (domain: string, keySecret: string) => {
          const key = join(dir, `${domain}.key`);
          const cert = join(dir, `${domain}.crt`);
          execFileSync('openssl', ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', key], { stdio: 'ignore' });
          execFileSync('openssl', ['req', '-new', '-x509', '-key', key, '-out', cert, '-days', '30',
            '-subj', `/CN=*.${domain}`, '-addext', `subjectAltName=DNS:*.${domain}`], { stdio: 'ignore' });
          const fields = certificateFields(readFileSync(cert, 'utf8'), readFileSync(key, 'utf8'), `*.${domain}`, keySecret);
          return { id: randomUUID(), wildcard_domain: `*.${domain}`, enabled: true, https_enabled: true, ...fields };
        };
        const readable = pool('a.test', secret);
        const lost = pool('b.test', 'some-other-secret-from-an-old-deploy');
        await database.insertInto('interaction.http_domain_pools').values([readable, lost]).execute();

        const snapshot = await service.buildSnapshot();
        expect(snapshot.domainPools.map((entry) => entry.id)).toEqual([readable.id]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
