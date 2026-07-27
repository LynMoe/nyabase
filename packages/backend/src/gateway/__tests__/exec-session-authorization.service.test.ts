import { describe, expect, it, vi } from 'vitest';
import {
  Capability,
  ContainerPhase,
  ContainerPowerIntent,
  UserStatus,
} from '@nyabase/common';
import {
  withPostgresTestDatabase,
  type PostgresTestDatabase,
} from '../../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../../persistence-pg/transaction.js';
import { ExecSessionAuthorizationService } from '../exec-session-authorization.service.js';
import type { ExecSessionInfo } from '../exec-session-registry.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

const OWNER_ID = '00000000-0000-4000-8000-000000000001';
const ADMIN_ID = '00000000-0000-4000-8000-000000000002';
const SERVER_ID = '00000000-0000-4000-8000-000000000003';
const IMAGE_ID = '00000000-0000-4000-8000-000000000004';
const CONTAINER_ID = '00000000-0000-4000-8000-000000000005';
const ADMIN_GROUP_ID = '00000000-0000-4000-8000-000000000006';
const SERVER_GROUP_ID = '00000000-0000-4000-8000-000000000007';

describePostgres('PostgreSQL ExecSessionAuthorizationService', () => {
  it('requires current owner, user, container, lifecycle, server, runtime, and JWT identity', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const authorization = await seed(fixture);
      const owner = info({ userId: OWNER_ID, authorizationKind: 'container-owner' });
      const version = await authVersion(fixture, OWNER_ID);
      await expect(authorization.isAuthorized(owner, version)).resolves.toBe(true);

      await fixture.database.updateTable('control.containers')
        .set({ bound_runtime_id: 'runtime-b' })
        .where('id', '=', CONTAINER_ID)
        .execute();
      await expect(authorization.isAuthorized(owner, version)).resolves.toBe(false);

      await fixture.database.updateTable('control.containers')
        .set({ bound_runtime_id: 'runtime-a' })
        .where('id', '=', CONTAINER_ID)
        .execute();
      await fixture.database.updateTable('iam.users')
        .set({ status: UserStatus.Disabled })
        .where('id', '=', OWNER_ID)
        .execute();
      await expect(authorization.isAuthorized(owner, version)).resolves.toBe(false);
    });
  });

  it('observes administrator capability and owner server-access revocation without a cache', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const authorization = await seed(fixture);
      const admin = info({
        userId: ADMIN_ID,
        authorizationKind: 'manage-containers-any',
      });
      const owner = info({ userId: OWNER_ID, authorizationKind: 'container-owner' });
      await expect(authorization.isAuthorizedForAdmission(admin)).resolves.toBe(true);
      await expect(authorization.isAuthorizedForAdmission(owner)).resolves.toBe(true);

      await fixture.database.updateTable('iam.groups')
        .set({ capabilities: [] })
        .where('id', '=', ADMIN_GROUP_ID)
        .execute();
      await fixture.database.deleteFrom('iam.server_grants')
        .where('user_id', '=', OWNER_ID)
        .where('server_id', '=', SERVER_ID)
        .execute();

      await expect(authorization.isAuthorizedForAdmission(admin)).resolves.toBe(false);
      await expect(authorization.isAuthorizedForAdmission(owner)).resolves.toBe(false);
    });
  });

  it('accepts group-derived owner server access and does not require it from a global admin', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const authorization = await seed(fixture);
      await fixture.database.insertInto('iam.groups').values({
        id: SERVER_GROUP_ID,
        name: 'Server users',
        description: null,
        priority: 0,
        is_system: false,
        system_key: null,
        capabilities: [],
        revision: 1,
      }).execute();
      await fixture.database.insertInto('iam.group_members').values({
        id: '00000000-0000-4000-8000-000000000008',
        group_id: SERVER_GROUP_ID,
        user_id: OWNER_ID,
      }).execute();
      await fixture.database.insertInto('iam.server_grants').values({
        id: '00000000-0000-4000-8000-000000000009',
        user_id: null,
        group_id: SERVER_GROUP_ID,
        server_id: SERVER_ID,
        cpu_millis: null,
        mem_bytes: null,
        disk_bytes: null,
        gpu_mode: null,
        gpu_indices: null,
      }).execute();
      await fixture.database.deleteFrom('iam.server_grants')
        .where('user_id', '=', OWNER_ID)
        .execute();

      await expect(authorization.isAuthorizedForAdmission(info({
        userId: OWNER_ID,
        authorizationKind: 'container-owner',
      }))).resolves.toBe(true);
      await expect(authorization.isAuthorizedForAdmission(info({
        userId: ADMIN_ID,
        authorizationKind: 'manage-containers-any',
      }))).resolves.toBe(true);
    });
  });

  it('starts the Agent side effect only for the exact current credential generation', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const authorization = await seed(fixture);
      const owner = info({ userId: OWNER_ID, authorizationKind: 'container-owner' });
      const version = await authVersion(fixture, OWNER_ID);
      const start = vi.fn(async () => 'started');

      const admitted = await authorization.startAuthorized(owner, version, start);
      expect(admitted).not.toBeNull();
      await expect(admitted!.result).resolves.toBe('started');

      await fixture.database.updateTable('iam.users')
        .set({ auth_version: version + 1 })
        .where('id', '=', OWNER_ID)
        .execute();
      await expect(authorization.startAuthorized(owner, version, start)).resolves.toBeNull();
      expect(start).toHaveBeenCalledTimes(1);
    });
  });

  it('does not start the Agent side effect when the atomic audit hook fails', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const authorization = await seed(fixture);
      const owner = info({ userId: OWNER_ID, authorizationKind: 'container-owner' });
      const version = await authVersion(fixture, OWNER_ID);
      const start = vi.fn(async () => 'started');
      await expect(authorization.startAuthorized(
        owner,
        version,
        start,
        async () => {
          throw new Error('audit unavailable');
        },
      )).rejects.toThrow('audit unavailable');
      expect(start).not.toHaveBeenCalled();
    });
  });

  it('serializes real Exec admission with server-access revocation in both orders', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const authorization = await seed(fixture);
      const owner = info({
        userId: OWNER_ID,
        authorizationKind: 'container-owner',
      });
      const version = await authVersion(fixture, OWNER_ID);
      const revoker = await fixture.pool.connect();
      try {
        // Revocation owns the policy barrier first: admission waits, observes
        // the committed revoke, and never starts an Agent side effect.
        await revoker.query('BEGIN');
        await revoker.query(
          `DELETE FROM iam.server_grants
           WHERE user_id = $1 AND server_id = $2`,
          [OWNER_ID, SERVER_ID],
        );
        const rejectedStart = vi.fn(async () => 'must-not-start');
        const rejectedAdmission = authorization.startAuthorized(
          owner,
          version,
          rejectedStart,
        );
        await expectStillPending(rejectedAdmission);
        await revoker.query('COMMIT');
        await expect(rejectedAdmission).resolves.toBeNull();
        expect(rejectedStart).not.toHaveBeenCalled();

        await fixture.database.insertInto('iam.server_grants').values(
          ownerServerGrant(),
        ).execute();
        const renewedVersion = await authVersion(fixture, OWNER_ID);

        // Admission owns the policy barrier first: revocation waits for the
        // authorization/audit/intent transaction to commit.
        const enteredAdmission = deferred<void>();
        const releaseAdmission = deferred<void>();
        const acceptedStart = vi.fn(async () => 'started');
        const acceptedAdmission = authorization.startAuthorized(
          owner,
          renewedVersion,
          acceptedStart,
          async () => {
            enteredAdmission.resolve();
            await releaseAdmission.promise;
          },
        );
        await enteredAdmission.promise;
        await revoker.query('BEGIN');
        const revokeBehindAdmission = revoker.query(
          `DELETE FROM iam.server_grants
           WHERE user_id = $1 AND server_id = $2`,
          [OWNER_ID, SERVER_ID],
        );
        await expectStillPending(revokeBehindAdmission);
        releaseAdmission.resolve();
        const accepted = await acceptedAdmission;
        expect(accepted).not.toBeNull();
        await expect(accepted!.result).resolves.toBe('started');
        await revokeBehindAdmission;
        await revoker.query('COMMIT');
        expect(acceptedStart).toHaveBeenCalledTimes(1);
      } finally {
        await revoker.query('ROLLBACK').catch(() => undefined);
        revoker.release(true);
      }
    });
  });
});

async function seed(fixture: PostgresTestDatabase): Promise<ExecSessionAuthorizationService> {
  await fixture.database.insertInto('iam.users').values([
    user(OWNER_ID, 1, 'owner'),
    user(ADMIN_ID, 2, 'admin'),
  ]).execute();
  await fixture.database.insertInto('iam.groups').values({
    id: ADMIN_GROUP_ID,
    name: 'Container administrators',
    description: null,
    priority: 0,
    is_system: false,
    system_key: null,
    capabilities: [Capability.ManageContainersAny],
    revision: 1,
  }).execute();
  await fixture.database.insertInto('iam.group_members').values({
    id: '00000000-0000-4000-8000-000000000010',
    group_id: ADMIN_GROUP_ID,
    user_id: ADMIN_ID,
  }).execute();
  await fixture.database.insertInto('infra.servers').values({
    id: SERVER_ID,
    name: 'Compute A',
    slug: 'compute-a',
    agent_token_hash: 'a'.repeat(64),
    host_fingerprint: null,
    agent_config_fingerprint: null,
    status: 'online',
    quarantine_code: null,
    quarantine_message: null,
    last_seen_at: null,
    macvlan_cidr: null,
    macvlan_gateway: null,
    macvlan_reserved_ips: JSON.stringify([]),
    revision: 1,
  }).execute();
  await fixture.database.insertInto('infra.images').values({
    id: IMAGE_ID,
    name: 'Base image',
    docker_image: 'example.invalid/base:latest',
    runtime_overrides: JSON.stringify({ uid: 0, entrypoint: null, cmd: null, init: false }),
    description: null,
    is_active: true,
    disable_ssh: false,
    deleting: false,
    cleanup_generation: 0,
    revision: 1,
  }).execute();
  await fixture.database.insertInto('iam.server_grants').values(
    ownerServerGrant(),
  ).execute();
  await fixture.database.insertInto('control.containers').values({
    id: CONTAINER_ID,
    server_id: SERVER_ID,
    owner_id: OWNER_ID,
    image_id: IMAGE_ID,
    created_by: OWNER_ID,
    name: 'notebook',
    revision: 1,
    desired_generation: 1,
    image_ref: 'example.invalid/base:latest',
    image_default_uid: 0,
    image_runtime_overrides: JSON.stringify({
      uid: 0,
      entrypoint: null,
      cmd: null,
      init: false,
    }),
    cpu_millis: 100,
    mem_bytes: 1024,
    disk_bytes: 1024,
    gpu_mode: 'none',
    gpu_indices: [],
    mounts_json: JSON.stringify([]),
    power_intent: ContainerPowerIntent.Running,
    lifecycle_phase: ContainerPhase.Active,
    bound_runtime_id: 'runtime-a',
    quota_paths: ['/runtime/diff', '/runtime/work'],
    runtime_spec_hash: 'spec-hash',
    active_task_id: null,
    last_transition_at: new Date(),
    failure_reason: null,
    failure_code: null,
  }).execute();
  const transactions = new PgTransactionManager(fixture.database);
  return new ExecSessionAuthorizationService(fixture.database, transactions);
}

function ownerServerGrant() {
  return {
    id: '00000000-0000-4000-8000-000000000011',
    user_id: OWNER_ID,
    group_id: null,
    server_id: SERVER_ID,
    cpu_millis: null,
    mem_bytes: null,
    disk_bytes: null,
    gpu_mode: null,
    gpu_indices: null,
  } as const;
}

function user(id: string, numericId: number, username: string) {
  return {
    id,
    numeric_id: numericId,
    username,
    password_hash: 'hash',
    display_name: username,
    status: UserStatus.Active,
    auth_version: 0,
    authz_version: 0,
  };
}

async function authVersion(fixture: PostgresTestDatabase, userId: string): Promise<number> {
  return (await fixture.database.selectFrom('iam.users')
    .select('auth_version')
    .where('id', '=', userId)
    .executeTakeFirstOrThrow()).auth_version;
}

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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function info(overrides: Partial<ExecSessionInfo> = {}): ExecSessionInfo {
  return {
    serverId: SERVER_ID,
    userId: OWNER_ID,
    containerId: CONTAINER_ID,
    dockerId: 'runtime-a',
    authorizationKind: 'container-owner',
    createdAt: Date.now(),
    claimed: true,
    ...overrides,
  };
}
