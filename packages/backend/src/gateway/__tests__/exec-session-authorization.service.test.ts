import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capability, ContainerPhase, UserStatus } from '@nyabase/common';
import { DataSource } from 'typeorm';
import { ExecSessionAuthorizationService } from '../exec-session-authorization.service.js';
import type { ExecSessionInfo } from '../exec-session-registry.js';

describe('ExecSessionAuthorizationService', () => {
  let dataSource: DataSource;
  let authorization: ExecSessionAuthorizationService;

  beforeEach(async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [] });
    await dataSource.initialize();
    await dataSource.query('CREATE TABLE users (id text PRIMARY KEY, status text NOT NULL, authVersion integer NOT NULL DEFAULT 0)');
    await dataSource.query('CREATE TABLE groups (id text PRIMARY KEY, capabilitiesJson text NOT NULL)');
    await dataSource.query('CREATE TABLE group_members (groupId text NOT NULL, userId text NOT NULL)');
    await dataSource.query(
      'CREATE TABLE server_grants (scope text NOT NULL, scopeId text NOT NULL, serverId text NOT NULL)',
    );
    await dataSource.query('CREATE TABLE containers (id text PRIMARY KEY, server_id text NOT NULL, owner_id text NOT NULL)');
    await dataSource.query(
      'CREATE TABLE container_lifecycle (container_id text PRIMARY KEY, phase text NOT NULL, bound_runtime_id text, active_task_id text)',
    );
    await dataSource.query(
      'INSERT INTO users (id, status) VALUES (?, ?), (?, ?)',
      ['owner-a', UserStatus.Active, 'admin-a', UserStatus.Active],
    );
    await dataSource.query(
      'INSERT INTO containers (id, server_id, owner_id) VALUES (?, ?, ?)',
      ['container-a', 'server-a', 'owner-a'],
    );
    await dataSource.query(
      'INSERT INTO container_lifecycle (container_id, phase, bound_runtime_id, active_task_id) VALUES (?, ?, ?, NULL)',
      ['container-a', ContainerPhase.Active, 'runtime-a'],
    );
    await dataSource.query(
      'INSERT INTO groups (id, capabilitiesJson) VALUES (?, ?)',
      ['admins', JSON.stringify([Capability.ManageContainersAny])],
    );
    await dataSource.query(
      'INSERT INTO group_members (groupId, userId) VALUES (?, ?)',
      ['admins', 'admin-a'],
    );
    await dataSource.query(
      'INSERT INTO server_grants (scope, scopeId, serverId) VALUES (?, ?, ?)',
      ['user', 'owner-a', 'server-a'],
    );
    authorization = new ExecSessionAuthorizationService(dataSource);
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('requires current owner, user, container, lifecycle, server, and runtime identity', async () => {
    const owner = info({ userId: 'owner-a', authorizationKind: 'container-owner' });
    await expect(authorization.isAuthorized(owner, 0)).resolves.toBe(true);

    await dataSource.query(
      'UPDATE container_lifecycle SET bound_runtime_id = ? WHERE container_id = ?',
      ['runtime-b', 'container-a'],
    );
    await expect(authorization.isAuthorized(owner, 0)).resolves.toBe(false);

    await dataSource.query(
      'UPDATE container_lifecycle SET bound_runtime_id = ? WHERE container_id = ?',
      ['runtime-a', 'container-a'],
    );
    await dataSource.query('UPDATE users SET status = ? WHERE id = ?', [UserStatus.Disabled, 'owner-a']);
    await expect(authorization.isAuthorized(owner, 0)).resolves.toBe(false);
  });

  it('observes an administrator capability revocation immediately without a cache', async () => {
    const admin = info({
      userId: 'admin-a',
      authorizationKind: 'manage-containers-any',
    });
    await expect(authorization.isAuthorized(admin, 0)).resolves.toBe(true);

    await dataSource.query(
      'UPDATE groups SET capabilitiesJson = ? WHERE id = ?',
      ['[]', 'admins'],
    );
    await expect(authorization.isAuthorized(admin, 0)).resolves.toBe(false);
  });

  it('requires current server access for an owner both before and during a console', async () => {
    const owner = info({ userId: 'owner-a', authorizationKind: 'container-owner' });
    await expect(authorization.isAuthorizedForAdmission(owner)).resolves.toBe(true);
    await expect(authorization.isAuthorized(owner, 0)).resolves.toBe(true);

    await dataSource.query(
      'DELETE FROM server_grants WHERE scope = ? AND scopeId = ? AND serverId = ?',
      ['user', 'owner-a', 'server-a'],
    );

    await expect(authorization.isAuthorizedForAdmission(owner)).resolves.toBe(false);
    await expect(authorization.isAuthorized(owner, 0)).resolves.toBe(false);
  });

  it('accepts group-derived server access and does not require it from a global admin', async () => {
    await dataSource.query(
      'INSERT INTO group_members (groupId, userId) VALUES (?, ?)',
      ['server-users', 'owner-a'],
    );
    await dataSource.query(
      'INSERT INTO server_grants (scope, scopeId, serverId) VALUES (?, ?, ?)',
      ['group', 'server-users', 'server-a'],
    );
    await dataSource.query(
      'DELETE FROM server_grants WHERE scope = ? AND scopeId = ?',
      ['user', 'owner-a'],
    );

    await expect(authorization.isAuthorized(
      info({ userId: 'owner-a', authorizationKind: 'container-owner' }),
      0,
    )).resolves.toBe(true);
    await expect(authorization.isAuthorizedForAdmission(info({
      userId: 'admin-a',
      authorizationKind: 'manage-containers-any',
    }))).resolves.toBe(true);
  });

  it('fails closed on malformed durable capability JSON', async () => {
    await dataSource.query(
      'UPDATE groups SET capabilitiesJson = ? WHERE id = ?',
      ['not-json', 'admins'],
    );
    await expect(authorization.isAuthorized(info({
      userId: 'admin-a',
      authorizationKind: 'manage-containers-any',
    }), 0)).resolves.toBe(false);
  });

  it('rejects a live console as soon as its JWT generation is revoked', async () => {
    const owner = info({ userId: 'owner-a', authorizationKind: 'container-owner' });
    await expect(authorization.isAuthorized(owner, 0)).resolves.toBe(true);

    await dataSource.query('UPDATE users SET authVersion = 1 WHERE id = ?', ['owner-a']);

    await expect(authorization.isAuthorized(owner, 0)).resolves.toBe(false);
    await expect(authorization.isAuthorized(owner, 1)).resolves.toBe(true);
  });

  it('does not start an Agent side effect after the exact HTTP credential generation is revoked', async () => {
    const owner = info({ userId: 'owner-a', authorizationKind: 'container-owner' });
    const start = vi.fn(async () => 'started');

    const admitted = await authorization.startAuthorized(owner, 0, start);
    expect(admitted).not.toBeNull();
    await expect(admitted!.result).resolves.toBe('started');

    await dataSource.query('UPDATE users SET authVersion = 1 WHERE id = ?', ['owner-a']);
    await expect(authorization.startAuthorized(owner, 0, start)).resolves.toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
  });
});

function info(overrides: Partial<ExecSessionInfo> = {}): ExecSessionInfo {
  return {
    serverId: 'server-a',
    userId: 'owner-a',
    containerId: 'container-a',
    dockerId: 'runtime-a',
    authorizationKind: 'container-owner',
    createdAt: Date.now(),
    claimed: true,
    ...overrides,
  };
}
