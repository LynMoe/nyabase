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
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import {
  SystemSettingsAuthorityService,
  SystemSettingsRevisionConflictError,
} from './system-settings-authority.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL
  ? describe.sequential
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
          initial.snapshotToken,
        )),
        database.transaction().execute((transaction) => authority.update(
          transaction,
          actorId,
          { 'branding.title': 'Writer B' },
          initial.revision,
          initial.snapshotToken,
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
          initial.snapshotToken,
        ))).rejects.toThrow('audit storage failed');

      await expect(database
        .selectFrom('system.settings')
        .select(['revision', 'snapshot_token'])
        .executeTakeFirstOrThrow()).resolves.toMatchObject({
        revision: '1',
        snapshot_token: initial.snapshotToken,
      });
      await expect(database
        .selectFrom('audit.events')
        .select((expression) => expression.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow()).resolves.toMatchObject({ count: '0' });
    });
  });

  it('reloads a second role by absolute version from a disposable Redis wake', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actorId = await seedActor(database);
      const redis = new LocalWakeBus();
      const apiConfig = makeConfig();
      const gatewayConfig = makeConfig();
      const api = makeAuthority(database, apiConfig, databaseAudit(), redis);
      const gateway = makeAuthority(
        database,
        gatewayConfig,
        databaseAudit(),
        redis,
      );
      await api.onApplicationBootstrap();
      await gateway.onApplicationBootstrap();
      try {
        const initial = await api.refreshFromPostgres();
        const next = await database.transaction().execute((transaction) =>
          api.update(
            transaction,
            actorId,
            { 'ssh.proxyPublicHost': 'ssh.roles.example' },
            initial.revision,
            initial.snapshotToken,
          ));
        await api.committed(next);

        expect(gatewayConfig.revision()).toBe(2);
        expect(gatewayConfig.get('ssh.proxyPublicHost'))
          .toBe('ssh.roles.example');
        expect(redis.publishedVersions).toEqual([2]);
      } finally {
        await api.onApplicationShutdown();
        await gateway.onApplicationShutdown();
      }
    });
  });

  it('converges by PostgreSQL polling when Redis publish and delivery are unavailable', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actorId = await seedActor(database);
      const unavailableRedis = {
        gatewayId: 'redis-unavailable',
        subscribe: vi.fn(async () => async () => undefined),
        publish: vi.fn(async () => false),
      };
      const apiConfig = makeConfig();
      const workerConfig = makeConfig();
      const api = makeAuthority(
        database,
        apiConfig,
        databaseAudit(),
        unavailableRedis,
      );
      const worker = makeAuthority(
        database,
        workerConfig,
        databaseAudit(),
        unavailableRedis,
      );
      const initial = await api.initialize();
      await worker.initialize();
      const next = await database.transaction().execute((transaction) =>
        api.update(
          transaction,
          actorId,
          { 'audit.retentionDays': 45 },
          initial.revision,
          initial.snapshotToken,
        ));
      await api.committed(next);

      expect(unavailableRedis.publish).toHaveBeenCalled();
      expect(workerConfig.revision()).toBe(1);
      await worker.refreshFromPostgres('poll-recovery');
      expect(workerConfig.revision()).toBe(2);
      expect(workerConfig.get('audit.retentionDays')).toBe(45);
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
            initial.snapshotToken,
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
          'redis.url',
          'runtime.role',
          'server.port',
          'metrics.vmagentUrl',
        ]));
      } finally {
        chmodSync(path, 0o644);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

function makeConfig(): NyabaseConfigService {
  vi.stubEnv('NYABASE_CONFIG_FILE', '/tmp/nyabase-system-settings-missing.yaml');
  return new NyabaseConfigService();
}

function makeAuthority(
  database: Kysely<NyabaseDatabase>,
  config: NyabaseConfigService,
  audit: AuditAppender,
  redis?: object,
): SystemSettingsAuthorityService {
  return new SystemSettingsAuthorityService(
    database,
    config,
    audit as never,
    { broadcastSnapshot: vi.fn().mockResolvedValue(undefined) } as never,
    redis as never,
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
): Promise<string> {
  const id = randomUUID();
  await database
    .insertInto('iam.users')
    .values({
      id,
      numeric_id: 100,
      username: `settings-${id.slice(0, 8)}`,
      password_hash: 'unused',
      display_name: 'Settings Admin',
      status: 'active',
      auth_version: 1,
      authz_version: 1,
    })
    .executeTakeFirstOrThrow();
  return id;
}

class LocalWakeBus {
  readonly gatewayId = 'settings-test-bus';
  readonly handlers = new Set<(payload: string) => void | Promise<void>>();
  readonly publishedVersions: number[] = [];

  async subscribe(
    _topic: string,
    handler: (payload: string) => void | Promise<void>,
  ): Promise<() => Promise<void>> {
    this.handlers.add(handler);
    return async () => {
      this.handlers.delete(handler);
    };
  }

  async publish(_topic: string, payload: string): Promise<boolean> {
    const version = (JSON.parse(payload) as { version: number }).version;
    this.publishedVersions.push(version);
    await Promise.all([...this.handlers].map((handler) => handler(payload)));
    return true;
  }
}
