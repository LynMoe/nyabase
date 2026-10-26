import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kysely, Transaction } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditAction } from '@nyabase/common';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import {
  SystemSettingsAuthorityService,
  SystemSettingsRevisionConflictError,
} from './system-settings-authority.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL
  ? describe
  : describe.skip;

afterEach(() => {
  vi.unstubAllEnvs();
});

describePg('System settings PostgreSQL authority', () => {
  it('admits exactly one concurrent CAS writer and atomically appends audit', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actorId = await seedActor(database);
      const config = makeConfig();
      const audit = databaseAudit();
      const authority = makeAuthority(database, config, audit);
      const initial = await authority.initialize();

      const attempts = await Promise.allSettled([
        database.transaction().execute((transaction) => authority.update(
          transaction,
          actorId,
          { 'branding.title': 'Writer A' },
          initial.revision,
        )),
        database.transaction().execute((transaction) => authority.update(
          transaction,
          actorId,
          { 'branding.title': 'Writer B' },
          initial.revision,
        )),
      ]);

      const winners = attempts.filter((attempt) => attempt.status === 'fulfilled');
      const losers = attempts.filter((attempt) => attempt.status === 'rejected');
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect((losers[0] as PromiseRejectedResult).reason)
        .toBeInstanceOf(SystemSettingsRevisionConflictError);
      const committed = (winners[0] as PromiseFulfilledResult<
        Awaited<ReturnType<typeof authority.update>>
      >).value;
      await authority.committed(committed);

      const row = await database
        .selectFrom('system.settings')
        .select(['revision', 'values'])
        .executeTakeFirstOrThrow();
      expect(row.revision).toBe('2');
      expect([
        'Writer A',
        'Writer B',
      ]).toContain((row.values as Record<string, unknown>)['branding.title']);
      const events = await database
        .selectFrom('audit.events')
        .select(['action', 'detail'])
        .execute();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: AuditAction.UpdateSystemSettings,
        detail: {
          keys: ['branding.title'],
          revision: 2,
        },
      });
    });
  });

  it('rolls back the setting CAS when its same-transaction audit append fails', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actorId = await seedActor(database);
      const config = makeConfig();
      const authority = makeAuthority(database, config, {
        append: vi.fn(async (transaction: Transaction<NyabaseDatabase>) => {
          await appendAudit(transaction, null);
          throw new Error('audit storage failed');
        }),
      });
      const initial = await authority.initialize();

      await expect(database.transaction().execute((transaction) =>
        authority.update(
          transaction,
          actorId,
          { 'branding.title': 'Must roll back' },
          initial.revision,
        ))).rejects.toThrow('audit storage failed');

      await expect(database
        .selectFrom('system.settings')
        .select(['revision'])
        .executeTakeFirstOrThrow()).resolves.toMatchObject({ revision: '1' });
      await expect(database
        .selectFrom('audit.events')
        .select((expression) => expression.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow()).resolves.toMatchObject({ count: '0' });
    });
  });

  it('keeps audit retention admin-only and refuses values that would wipe the log', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const operatorId = await seedActor(database, 'operator');
      const adminId = await seedActor(database, 'admin');
      const authority = makeAuthority(database, makeConfig(), databaseAudit());
      const initial = await authority.initialize();

      await expect(database.transaction().execute((transaction) =>
        authority.update(transaction, operatorId, { 'audit.retentionMaxEntries': 20_000 }, initial.revision)))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: 'ROLE_REQUIRED' }) });
      // Session lifetimes decide how long a stolen session lives: admin only too.
      for (const change of [
        { 'auth.refreshTokenExpiresDays': 365 },
        { 'auth.sessionMaxLifetimeDays': 365 },
      ]) {
        await expect(database.transaction().execute((transaction) =>
          authority.update(transaction, operatorId, change, initial.revision)))
          .rejects.toMatchObject({ response: expect.objectContaining({ code: 'ROLE_REQUIRED' }) });
      }
      await expect(database.transaction().execute((transaction) =>
        authority.update(transaction, adminId, { 'audit.retentionMaxEntries': 1 }, initial.revision)))
        .rejects.toThrow('Invalid config value for audit.retentionMaxEntries');
      await expect(database.transaction().execute((transaction) =>
        authority.update(transaction, adminId, { 'audit.retentionDays': 1 }, initial.revision)))
        .rejects.toThrow('Invalid config value for audit.retentionDays');
      const next = await database.transaction().execute((transaction) =>
        authority.update(transaction, adminId, { 'audit.retentionMaxEntries': 0 }, initial.revision));
      expect(next.values['audit.retentionMaxEntries']).toBe(0);
      // Operators keep editing the rest.
      await expect(database.transaction().execute((transaction) =>
        authority.update(transaction, operatorId, { 'branding.title': 'Ops' }, next.revision)))
        .resolves.toMatchObject({ revision: next.revision + 1 });
    });
  });

  it('ignores a stored key that is no longer a setting', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actorId = await seedActor(database);
      const authority = makeAuthority(database, makeConfig(), databaseAudit());
      const initial = await authority.initialize();
      // incus.preflightEgressUrl was removed with the preflight egress check.
      await database
        .updateTable('system.settings')
        .set({ values: { ...initial.values, 'incus.preflightEgressUrl': 'https://example.com/' } })
        .execute();

      const restarted = makeAuthority(database, makeConfig(), databaseAudit());
      const loaded = await restarted.initialize();
      expect(loaded.revision).toBe(initial.revision);
      const next = await database.transaction().execute((transaction) =>
        restarted.update(transaction, actorId, { 'audit.retentionDays': 45 }, loaded.revision));
      await restarted.committed(next);
      expect(next.revision).toBe(initial.revision + 1);
    });
  });

  it('rejects a stale revision with the committed value so the client can resolve it', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actorId = await seedActor(database);
      const authority = makeAuthority(database, makeConfig(), databaseAudit());
      const initial = await authority.initialize();
      const next = await database.transaction().execute((transaction) =>
        authority.update(
          transaction,
          actorId,
          { 'audit.retentionDays': 45 },
          initial.revision,
        ));
      await authority.committed(next);

      const error = await database.transaction().execute((transaction) =>
        authority.update(
          transaction,
          actorId,
          { 'audit.retentionDays': 90 },
          initial.revision,
        )).then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(SystemSettingsRevisionConflictError);
      const conflict = error as SystemSettingsRevisionConflictError;
      expect(conflict.currentRevision).toBe(2);
      expect(conflict.current.values['audit.retentionDays']).toBe(45);
      const row = await database
        .selectFrom('system.settings')
        .select('revision')
        .executeTakeFirstOrThrow();
      expect(row.revision).toBe('2');
    });
  });

  it('survives restart with read-only YAML while secrets stay out of PostgreSQL', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actorId = await seedActor(database);
      const dir = mkdtempSync(join(tmpdir(), 'nyabase-settings-restart-'));
      const path = join(dir, 'config.yaml');
      const yaml = [
        'server:',
        '  port: 4310',
        'branding:',
        '  title: Migrated bootstrap title',
        'auth:',
        '  jwtSecret: restart-secret-that-is-more-than-thirty-two-characters',
        '',
      ].join('\n');
      writeFileSync(path, yaml);
      chmodSync(path, 0o444);
      vi.stubEnv('NYABASE_CONFIG_FILE', path);
      vi.stubEnv('JWT_SECRET', '');

      try {
        const firstConfig = new NyabaseConfigService();
        const first = makeAuthority(database, firstConfig, databaseAudit());
        const initial = await first.initialize();
        expect(firstConfig.get('branding.title'))
          .toBe('Migrated bootstrap title');
        const updated = await database.transaction().execute((transaction) =>
          first.update(
            transaction,
            actorId,
            { 'branding.title': 'Persisted database title' },
            initial.revision,
            ));
        await first.committed(updated);

        const restartedConfig = new NyabaseConfigService();
        expect(restartedConfig.get('branding.title'))
          .toBe('Migrated bootstrap title');
        await makeAuthority(
          database,
          restartedConfig,
          databaseAudit(),
        ).initialize();
        expect(restartedConfig.get('branding.title'))
          .toBe('Persisted database title');
        expect(restartedConfig.get('server.port')).toBe(4310);
        expect(restartedConfig.get('auth.jwtSecret'))
          .toBe('restart-secret-that-is-more-than-thirty-two-characters');
        expect(readFileSync(path, 'utf8')).toBe(yaml);

        const row = await database
          .selectFrom('system.settings')
          .select('values')
          .executeTakeFirstOrThrow();
        const keys = Object.keys(row.values as Record<string, unknown>);
        expect(keys).toEqual(expect.arrayContaining([
          'branding.title',
          'branding.description',
          'auth.refreshTokenExpiresDays',
          'audit.retentionDays',
          'audit.retentionMaxEntries',
          'ssh.proxyPublicHost',
          'ssh.proxyPublicPort',
          'ssh.proxySnapshotStaleMs',
        ]));
        expect(keys).not.toEqual(expect.arrayContaining([
          'auth.jwtSecret',
          'auth.adminInitPassword',
          'database.url',
          'server.port',
        ]));
      } finally {
        chmodSync(path, 0o644);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

function makeConfig(): NyabaseConfigService {
  vi.stubEnv('NYABASE_CONFIG_FILE', '/tmp/nyabase-settings-missing.yaml');
  return new NyabaseConfigService();
}

function makeAuthority(
  database: Kysely<NyabaseDatabase>,
  config: NyabaseConfigService,
  audit: AuditAppender,
): SystemSettingsAuthorityService {
  return new SystemSettingsAuthorityService(
    database,
    config,
    audit as never,
    { broadcastSnapshot: vi.fn().mockResolvedValue(undefined) } as never,
    { startReconcileAllHostCertificates: vi.fn() } as never,
  );
}

interface AuditAppender {
  append(
    transaction: Transaction<NyabaseDatabase>,
    actorId: string,
    action: AuditAction,
    targetId: string,
    targetType: string,
    payload?: unknown,
  ): Promise<void>;
}

function databaseAudit(): AuditAppender {
  return {
    append: vi.fn(async (
      transaction: Transaction<NyabaseDatabase>,
      _actorId: string,
      _action: AuditAction,
      _targetId: string,
      _targetType: string,
      payload: unknown,
    ) => appendAudit(transaction, payload)),
  };
}

async function appendAudit(
  transaction: Transaction<NyabaseDatabase>,
  payload: unknown,
): Promise<void> {
  await transaction
    .insertInto('audit.events')
    .values({
      id: randomUUID(),
      actor_id: null,
      actor_name: null,
      actor_username: null,
      actor_snapshot: null,
      action: AuditAction.UpdateSystemSettings,
      target_id: 'control-plane',
      target_type: 'system_settings',
      target_name: null,
      target_snapshot: null,
      related: '[]',
      detail: JSON.stringify(payload),
      occurred_at: new Date(),
    })
    .executeTakeFirstOrThrow();
}

async function seedActor(
  database: Kysely<NyabaseDatabase>,
  role: 'admin' | 'operator' = 'admin',
): Promise<string> {
  const id = randomUUID();
  await database
    .insertInto('iam.users')
    .values({
      id,
      numeric_id: role === 'admin' ? 100 : 101,
      username: `settings-${id.slice(0, 8)}`,
      password_hash: 'unused',
      display_name: 'Settings Admin',
      status: 'active',
      role,
      auth_version: 1,
    })
    .executeTakeFirstOrThrow();
  return id;
}
