import { randomUUID } from 'node:crypto';
import {
  ContainerPhase,
  ContainerPowerIntent,
  ServerStatus,
  UserStatus,
} from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import {
  withPostgresTestDatabase,
  type PostgresTestDatabase,
} from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { usersPgFixture } from '../users/users.pg-test-helper.js';
import { ExecSessionAuthorizationService } from './exec-session-authorization.service.js';
import type { ExecSessionInfo } from './exec-session-registry.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('exec authorization mutation barrier', () => {
  it('serializes exec admission and IAM revocation in both lock orders', async () => {
    await withPostgresTestDatabase(async ({ pool }) => {
      const userId = randomUUID();
      await pool.query(
        `INSERT INTO iam.users
          (id, numeric_id, username, password_hash, display_name)
         VALUES ($1, 1001, 'barrier_user', 'hash', 'Barrier user')`,
        [userId],
      );
      const first = await pool.connect();
      const second = await pool.connect();
      try {
        await first.query('BEGIN');
        await first.query(
          'SELECT 1 FROM iam.policy_state WHERE singleton = true FOR UPDATE',
        );
        await second.query('BEGIN');
        const revokeBehindAdmission = second.query(
          `UPDATE iam.users
           SET status = 'disabled', auth_version = auth_version + 1
           WHERE id = $1`,
          [userId],
        );
        await expectStillPending(revokeBehindAdmission);
        await first.query('COMMIT');
        await revokeBehindAdmission;
        await second.query('COMMIT');

        await first.query('BEGIN');
        await first.query(
          `UPDATE iam.users
           SET status = 'active', auth_version = auth_version + 1
           WHERE id = $1`,
          [userId],
        );
        await second.query('BEGIN');
        const admissionBehindRevoke = second.query(
          'SELECT 1 FROM iam.policy_state WHERE singleton = true FOR UPDATE',
        );
        await expectStillPending(admissionBehindRevoke);
        await first.query('COMMIT');
        await admissionBehindRevoke;
        await second.query('COMMIT');
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        await second.query('ROLLBACK').catch(() => undefined);
        // These dedicated lock-order clients are not reused by Kysely. Destroy
        // them explicitly so the disposable database teardown never needs to
        // terminate a still-open pooled socket.
        first.release(true);
        second.release(true);
      }
    });
  });

  it('lets admission linearize before a UsersService status update already holding the user row', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const users = await usersPgFixture(fixture);
      const admission = await fixture.pool.connect();
      try {
        await admission.query('BEGIN');
        await admission.query(
          'SELECT 1 FROM iam.policy_state WHERE singleton = true FOR UPDATE',
        );
        const update = users.users.updateUser(users.userId, {
          status: UserStatus.Disabled,
        });
        await expectStillPending(update);

        // Admission reads the last committed credential generation without
        // taking the user row lock. If it tried FOR UPDATE here, this would
        // deadlock with UsersService (user -> policy).
        await expect(admission.query(
          'SELECT status, auth_version FROM iam.users WHERE id = $1',
          [users.userId],
        )).resolves.toMatchObject({
          rows: [{ status: UserStatus.Active, auth_version: 0 }],
        });
        await admission.query('COMMIT');
        await expect(update).resolves.toMatchObject({ status: UserStatus.Disabled });
      } finally {
        await admission.query('ROLLBACK').catch(() => undefined);
        admission.release(true);
      }
    });
  });

  it('holds a server-grant DELETE behind an admitted exec policy barrier', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const info = await seedExecAuthority(fixture);
      const userId = info.userId;
      const authorization = new ExecSessionAuthorizationService(
        fixture.database,
        new PgTransactionManager(fixture.database),
      );
      const authVersion = (await fixture.database.selectFrom('iam.users')
        .select('auth_version')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow()).auth_version;
      const admissionEntered = deferred<void>();
      const releaseAdmission = deferred<void>();
      const admission = authorization.startAuthorized(
        info,
        authVersion,
        async () => 'started',
        async () => {
          admissionEntered.resolve();
          await releaseAdmission.promise;
        },
      );
      await admissionEntered.promise;

      const deletion = fixture.database.deleteFrom('iam.server_grants')
        .where('user_id', '=', userId)
        .where('server_id', '=', info.serverId)
        .execute();
      await expectStillPending(deletion);
      releaseAdmission.resolve();
      const admitted = await admission;
      expect(admitted).not.toBeNull();
      await expect(admitted!.result).resolves.toBe('started');
      await expect(deletion).resolves.toHaveLength(1);
      await expect(authorization.isAuthorizedForAdmission(info)).resolves.toBe(false);
    });
  });
});

async function expectStillPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.finally(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
  expect(settled).toBe(false);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function seedExecAuthority(
  fixture: PostgresTestDatabase,
  existingUserId?: string,
): Promise<ExecSessionInfo> {
  const userId = existingUserId ?? randomUUID();
  const serverId = randomUUID();
  const imageId = randomUUID();
  const containerId = randomUUID();
  if (!existingUserId) {
    await fixture.database.insertInto('iam.users').values({
      id: userId,
      numeric_id: 2_001,
      username: `exec-${userId.slice(0, 8)}`,
      password_hash: 'hash',
      display_name: 'Exec user',
      status: UserStatus.Active,
      auth_version: 0,
      authz_version: 0,
    }).execute();
  }
  await fixture.database.insertInto('infra.servers').values({
    id: serverId,
    name: 'Barrier compute',
    slug: `barrier-${serverId.slice(0, 8)}`,
    agent_token_hash: 'a'.repeat(64),
    host_fingerprint: null,
    agent_config_fingerprint: null,
    status: ServerStatus.Online,
    quarantine_code: null,
    quarantine_message: null,
    last_seen_at: null,
    macvlan_cidr: null,
    macvlan_gateway: null,
    macvlan_reserved_ips: '[]',
    revision: 1,
  }).execute();
  await fixture.database.insertInto('infra.images').values({
    id: imageId,
    name: 'Barrier image',
    docker_image: 'example.invalid/barrier:latest',
    runtime_overrides: JSON.stringify({ uid: 0, entrypoint: null, cmd: null, init: false }),
    description: null,
    is_active: true,
    disable_ssh: false,
    deleting: false,
    cleanup_generation: 0,
    revision: 1,
  }).execute();
  await fixture.database.insertInto('iam.server_grants').values({
    id: randomUUID(),
    user_id: userId,
    group_id: null,
    server_id: serverId,
    cpu_millis: null,
    mem_bytes: null,
    disk_bytes: null,
    gpu_mode: null,
    gpu_indices: null,
  }).execute();
  await fixture.database.insertInto('control.containers').values({
    id: containerId,
    server_id: serverId,
    owner_id: userId,
    image_id: imageId,
    created_by: userId,
    name: 'barrier-shell',
    revision: 1,
    desired_generation: 1,
    image_ref: 'example.invalid/barrier:latest',
    image_default_uid: 0,
    image_runtime_overrides: JSON.stringify({
      uid: 0,
      entrypoint: null,
      cmd: null,
      init: false,
    }),
    cpu_millis: 100,
    mem_bytes: 1_024,
    disk_bytes: 1_024,
    gpu_mode: 'none',
    gpu_indices: [],
    mounts_json: '[]',
    power_intent: ContainerPowerIntent.Running,
    lifecycle_phase: ContainerPhase.Active,
    bound_runtime_id: 'barrier-runtime',
    quota_paths: ['/runtime/diff', '/runtime/work'],
    runtime_spec_hash: 'barrier-spec',
    active_task_id: null,
    last_transition_at: new Date(),
    failure_reason: null,
    failure_code: null,
  }).execute();
  return {
    serverId,
    userId,
    containerId,
    dockerId: 'barrier-runtime',
    authorizationKind: 'container-owner',
    createdAt: Date.now(),
    claimed: false,
  };
}
