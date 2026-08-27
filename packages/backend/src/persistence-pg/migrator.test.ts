import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertFreshInitialMigrationManifest,
  discoverSqlMigrations,
  runSqlMigrations,
} from './migrator.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function migrationDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nyabase-pg-migrations-'));
  roots.push(root);
  return root;
}

describe('SQL migration discovery', () => {
  it('discovers exactly one clean PostgreSQL initial migration', async () => {
    const migrations = await discoverSqlMigrations(resolve(__dirname, 'migrations'));
    expect(migrations.map(({ version, name }) => ({ version, name }))).toEqual([
      { version: '000001', name: 'initial' },
      { version: '000002', name: 'reconcile-busy-strikes' },
      { version: '000003', name: 'container-root-used-bytes' },
    ]);
    const [initial] = migrations;
    expect(initial.sql).toContain('CREATE TABLE iam.users');
    expect(initial.sql).toContain('CREATE TABLE iam.server_grants');
    expect(initial.sql).toContain('CREATE TABLE iam.storage_pool_grants');
    expect(initial.sql).toContain('CREATE TABLE iam.shared_backend_grants');
    expect(initial.sql).toContain('CREATE TABLE control.containers');
    expect(initial.sql).toContain('CREATE TABLE control.volumes');
    expect(initial.sql).toContain('CREATE TABLE control.volume_attachments');
    expect(initial.sql).toContain('CREATE TABLE control.intents');
    expect(initial.sql).toContain('CREATE TABLE control.reconcile_claims');
    expect(initial.sql).toContain('CREATE TABLE infra.storage_pools');
    expect(initial.sql).toContain('CREATE TABLE infra.shared_backends');
    expect(initial.sql).toContain('CREATE TABLE infra.image_server_assignments');
    expect(initial.sql).toContain('CREATE TABLE system.incus_client_certificates');
    expect(initial.sql).toContain('CREATE TABLE system.incus_client_certificate_trusts');
    expect(initial.sql).toContain('CREATE TABLE interaction.ssh_proxy_host_keys');
    expect(initial.sql).toContain('CREATE TABLE interaction.http_proxy_bindings');
    expect(initial.sql).toContain('CREATE TABLE system.settings');
    expect(initial.sql).toContain('storage_pools_shared_backend_server_unique');
    expect(initial.sql).toContain('volume_attachments_backend_visibility');
    expect(initial.sql).toContain('incus_client_certificates_active_unique');
    expect(initial.sql).toContain('intents_settled_shape_check');
    expect(initial.sql).toContain('lock_policy_state_before_mutation');
    expect(initial.sql).not.toMatch(/\bCREATE\s+SCHEMA\s+workflow\b/i);
    expect(initial.sql).not.toMatch(/\bworkflow\./i);
    expect(initial.sql).not.toMatch(/\b(agent|docker|macvlan|xfs|quarantine)\b/i);
    expect(initial.sql).not.toMatch(/\b(gpu_indices|agent_token_hash|bridge_parent)\b/i);
    expect(initial.sql).not.toMatch(/\b(remote_fs|data_directories|container_mounts|quota_desired)\b/i);
    expect(initial.sql).not.toMatch(/\b(image_grants|mount_source_grants)\b/i);
    expect(initial.sql).not.toContain('published_at timestamp');
    expect(initial.sql).not.toContain('outbox_attempt_count_check');
    expect(initial.sql).not.toMatch(/\bADD\s+COLUMN\b/i);
    expect(initial.sql).not.toMatch(/\bDROP\s+(?:COLUMN|CONSTRAINT)\b/i);
    expect(initial.sql).not.toMatch(/\bALTER\s+COLUMN\s+\w+\s+TYPE\b/i);
    expect(initial.sql).not.toContain('UPDATE control.container_network_claims\nSET owner_kind');
  });

  it('orders migrations and calculates stable checksums', async () => {
    const directory = await migrationDirectory();
    await writeFile(join(directory, '000002_second.sql'), 'SELECT 2;');
    await writeFile(join(directory, '000001_first.sql'), 'SELECT 1;');

    const first = await discoverSqlMigrations(directory);
    const second = await discoverSqlMigrations(directory);

    expect(first.map((migration) => migration.version)).toEqual(['000001', '000002']);
    expect(first[0].checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(second[0].checksum).toBe(first[0].checksum);
  });

  it('rejects ambiguous or malformed migration identities', async () => {
    const duplicate = await migrationDirectory();
    await writeFile(join(duplicate, '000001_first.sql'), 'SELECT 1;');
    await writeFile(join(duplicate, '000001_other.sql'), 'SELECT 2;');
    await expect(discoverSqlMigrations(duplicate)).rejects.toThrow('Duplicate');

    const malformed = await migrationDirectory();
    await writeFile(join(malformed, '1_bad.sql'), 'SELECT 1;');
    await expect(discoverSqlMigrations(malformed)).rejects.toThrow('Invalid');
  });

  it('rejects an empty or compatibility-style product manifest', async () => {
    expect(() => assertFreshInitialMigrationManifest([]))
      .toThrow('exactly one fresh migration');
    expect(() => assertFreshInitialMigrationManifest([{
      version: '000002',
      name: 'compatibility',
      path: '/tmp/000002_compatibility.sql',
      sql: 'SELECT 1;',
      checksum: '0'.repeat(64),
    }])).toThrow('000001_initial.sql');
  });
});

describe('SQL migration lock timeout contract', () => {
  it('wraps a driver read timeout and always releases the pool client', async () => {
    const client = {
      query: vi.fn().mockRejectedValue(new Error('Query read timeout')),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    };

    await expect(runSqlMigrations(
      pool as never,
      '/not-reached',
      { lockTimeoutMs: 20, retryIntervalMs: 10 },
    )).rejects.toThrow(
      'Timed out after 20ms waiting for PostgreSQL migration lock',
    );

    expect(client.query).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledWith(expect.objectContaining({
      query_timeout: expect.any(Number),
    }));
    expect(client.query.mock.calls[0]![0].query_timeout).toBeGreaterThan(20);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
