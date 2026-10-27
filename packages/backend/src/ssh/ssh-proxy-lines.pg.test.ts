import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AuditAction, FailureCode } from '@nyabase/common';
import { pgMigrationsDirectory } from '../platform/persistence-pg/persistence-pg.module.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { SshProxyLinesService } from './ssh-proxy-lines.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;
const ACTOR = '00000000-0000-4000-8000-000000000001';

describePg('SSH proxy lines', () => {
  it('keeps the administrators order across create, reorder and delete', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const append = vi.fn(async () => undefined);
      const lines = new SshProxyLinesService(database, new PgTransactionManager(database), { append } as never);

      const auto = await lines.create(ACTOR, { name: '自动', host: 'ssh.example.com', port: 2222, hint: null });
      const campus = await lines.create(ACTOR, { name: '校园网', host: '10.0.0.1', port: 22, hint: '仅限校内' });
      const guangzhou = await lines.create(ACTOR, { name: '广州', host: 'gz.example.com', port: 52515, hint: null });
      expect((await lines.list()).map((line) => line.name)).toEqual(['自动', '校园网', '广州']);

      await expect(lines.create(ACTOR, { name: '自动', host: 'h', port: 22, hint: null }))
        .rejects.toMatchObject({ response: { code: FailureCode.SshProxyLineConflict } });
      await expect(lines.patch(ACTOR, campus.id, { name: '广州' }))
        .rejects.toMatchObject({ response: { code: FailureCode.SshProxyLineConflict } });

      expect(await lines.patch(ACTOR, campus.id, { hint: null, port: 2200 }))
        .toEqual({ ...campus, hint: null, port: 2200 });
      await expect(lines.patch(ACTOR, 'not-a-uuid', { port: 1 })).rejects.toMatchObject({ status: 404 });

      expect((await lines.reorder(ACTOR, { ids: [guangzhou.id, auto.id, campus.id] })).map((line) => line.name))
        .toEqual(['广州', '自动', '校园网']);
      await expect(lines.reorder(ACTOR, { ids: [auto.id, campus.id] }))
        .rejects.toMatchObject({ response: { code: FailureCode.RevisionConflict } });

      await lines.delete(ACTOR, guangzhou.id);
      const third = await lines.create(ACTOR, { name: '香港', host: 'hk.example.com', port: 22, hint: null });
      expect((await lines.list()).map((line) => line.id)).toEqual([auto.id, campus.id, third.id]);
      expect(append.mock.calls.map((call) => (call as unknown[])[2])).toEqual([
        AuditAction.CreateSshProxyLine,
        AuditAction.CreateSshProxyLine,
        AuditAction.CreateSshProxyLine,
        AuditAction.UpdateSshProxyLine,
        AuditAction.ReorderSshProxyLines,
        AuditAction.DeleteSshProxyLine,
        AuditAction.CreateSshProxyLine,
      ]);
    });
  });

  it('turns the old public address setting into the first line', async () => {
    await withPostgresTestDatabase(async ({ pool, database }) => {
      const migration = await readFile(join(pgMigrationsDirectory(), '000002_ssh-proxy-lines.sql'), 'utf8');
      await pool.query('DROP TABLE interaction.ssh_proxy_lines');
      await pool.query(
        `INSERT INTO system.settings (singleton, revision, "values") VALUES (true, 7, $1)`,
        [JSON.stringify({ 'ssh.proxyPublicHost': ' SSH.Example.com ', 'ssh.proxyPublicPort': 52515, 'branding.title': 'nya' })],
      );
      await pool.query(`BEGIN; ${migration} COMMIT;`);

      const lines = await database.selectFrom('interaction.ssh_proxy_lines')
        .select(['name', 'host', 'port', 'hint', 'sort_order']).execute();
      expect(lines).toEqual([{ name: '默认', host: 'ssh.example.com', port: 52515, hint: null, sort_order: 0 }]);
      const settings = await database.selectFrom('system.settings').select(['revision', 'values']).executeTakeFirstOrThrow();
      expect(settings.revision).toBe('8');
      expect(settings.values).toEqual({ 'branding.title': 'nya' });
    });
  });
});
