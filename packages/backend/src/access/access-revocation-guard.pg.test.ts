import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { ServerStatus, UserStatus } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { InfrastructureRepository } from '../infrastructure/infrastructure.repository.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { AccessRevocationGuardService } from './access-revocation-guard.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('PostgreSQL authorization revocation dependencies', () => {
  it('blocks local container dependencies on server-grant revoke', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database, 'guard-local');
      const serverId = await seedServer(database);
      await database.insertInto('control.authorization_dependencies').values({
        id: randomUUID(),
        dependency_kind: 'container',
        dependency_id: randomUUID(),
        user_id: userId,
        server_id: serverId,
        pool_id: null,
        shared_backend_id: null,
      }).execute();

      await expect(database.transaction().execute((transaction) =>
        new AccessRevocationGuardService().assertServerAccessRevocationSafe(
          transaction,
          [{ userId, serverId }],
        ))).rejects.toBeInstanceOf(ConflictException);
    });
  });

  it('does not let a shared-volume dependency block server-grant revoke', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database, 'guard-shared');
      const sharedBackendId = randomUUID();
      await database.insertInto('infra.shared_backends').values({
        id: sharedBackendId,
        name: `backend-${sharedBackendId.slice(0, 8)}`,
        display_name: null,
        identity_key: `identity-${sharedBackendId}`,
        ceph_fsid: sharedBackendId,
        total_bytes: null,
        used_bytes: null,
        overcommit_ratio: 1,
        revision: 1,
      }).execute();
      const serverId = await seedServer(database);
      await database.insertInto('control.authorization_dependencies').values({
        id: randomUUID(),
        dependency_kind: 'volume',
        dependency_id: randomUUID(),
        user_id: userId,
        server_id: null,
        pool_id: null,
        shared_backend_id: sharedBackendId,
      }).execute();

      await expect(database.transaction().execute((transaction) =>
        new AccessRevocationGuardService().assertServerAccessRevocationSafe(
          transaction,
          [{ userId, serverId }],
        ))).resolves.toBeUndefined();
    });
  });
});

let nextNumericId = 1;

async function seedUser(database: import('kysely').Kysely<NyabaseDatabase>, username: string): Promise<string> {
  const id = randomUUID();
  await database.insertInto('iam.users').values({
    id,
    numeric_id: nextNumericId++,
    username,
    password_hash: 'unused',
    display_name: username,
    status: UserStatus.Active,
    auth_version: 1,
    authz_version: 1,
  }).execute();
  return id;
}

async function seedServer(database: import('kysely').Kysely<NyabaseDatabase>): Promise<string> {
  const id = randomUUID();
  await new InfrastructureRepository(database).insertServer({
    id,
    name: `Guard server ${id.slice(0, 8)}`,
    slug: `guard-${id.slice(0, 8)}`,
    api_endpoint: 'https://incus.example.test:8443',
    server_cert_fingerprint: null,
    incus_version: null,
    api_extensions: [],
    system_pool_id: null,
    storage_overcommit_ratio: 1,
    parent_interface: 'eth0',
    dns_servers: ['10.20.0.1'],
    gpu_runtime_available: false,
    status: ServerStatus.Unknown,
    last_seen_at: null,
    last_error: null,
    revision: 1,
    node_metrics_endpoint: null,
    node_metrics_server_cert_fingerprint: null,
    node_metrics_token_ciphertext: null,
    node_metrics_token_fingerprint: null,
    node_metrics_status: 'unconfigured',
    node_metrics_last_success_at: null,
    node_metrics_outage_since: null,
    node_metrics_last_error: null,
    preflight_status: 'not_run',
    preflight_checked_at: null,
    preflight_report: null,
  });
  return id;
}
