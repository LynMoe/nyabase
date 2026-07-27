import type { APIRequestContext, APIResponse } from '@playwright/test';
import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { waitForAgentTask } from '../../support/durable-api.js';
import { expectJson, expectSuccess } from '../../support/http.js';
import { aggregateErrorWithDiagnostics } from '../../support/error-diagnostics.mjs';
import { currentRunId, requireRuntimeEnv } from '../../support/runtime-env.js';
import { createHash } from 'node:crypto';

interface UserView {
  id: string;
  username: string;
  displayName: string;
  status: 'active' | 'disabled' | 'deleting' | 'deleted';
  capabilities: string[];
  groups: Array<{ id: string; name: string }>;
}

interface LoginView {
  accessToken: string;
  refreshToken: string;
  user: UserView;
}

function refreshRequestId(label: string): string {
  return createHash('sha256').update(`${currentRunId()}:${label}`).digest('hex');
}

interface GroupView {
  id: string;
  name: string;
  description: string | null;
  priority: number;
  isSystem: boolean;
  capabilities: string[];
  revision: number;
}

interface CatalogUserView {
  id: string;
  username: string;
  displayName: string;
  status: UserView['status'];
}

interface CatalogGroupView {
  id: string;
  name: string;
  isSystem: boolean;
}

interface GroupMemberView {
  userId: string;
  username: string;
  displayName: string;
}

interface CatalogGrantServerView {
  id: string;
  name: string;
  slug: string;
  status: string;
  runtimeReady: boolean;
  gpus: unknown[];
}

interface CatalogGrantImageView {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

interface ActionAvailabilityView {
  allowed: boolean;
  reason: string | null;
  missingCapabilities: string[];
}

interface AdministrationActionsView {
  actorCapabilities: string[];
  assignableGroupCapabilities: string[];
  createUser: ActionAvailabilityView;
  createGroup: ActionAvailabilityView;
  users: Record<string, {
    canAdminister: ActionAvailabilityView;
    canDelete: ActionAvailabilityView;
  }>;
  groups: Record<string, {
    canEditMetadata: ActionAvailabilityView;
    canEditPriority: ActionAvailabilityView;
    canManageMembers: ActionAvailabilityView;
    canRemoveMembers: Record<string, ActionAvailabilityView>;
    canDelete: ActionAvailabilityView;
  }>;
}

interface SshKeyView {
  id: string;
  name: string;
  keyText: string;
}

interface TaskIdsView {
  taskIds: string[];
}

interface ServerAccessView {
  serverId: string;
  cpuMillis: number;
  memBytes: number;
  diskBytes: number;
  gpuMode: string;
  gpuIndices: number[];
  allowedImageIds: string[];
}

interface EffectiveAccessView {
  servers: ServerAccessView[];
}

interface ApiTokenView {
  token: { id: string; name: string };
  secret: string;
}

interface RefreshView {
  accessToken: string;
  refreshToken: string;
}

interface ImageGrantView {
  id: string;
  scope: 'group' | 'user';
  scopeId: string;
  imageId: string;
  serverId: string;
  createdAt: string;
}

interface MountSourceGrantView {
  id: string;
  scope: 'group' | 'user';
  scopeId: string;
  sourceKind: 'local' | 'remote';
  sourceId: string;
  serverId: string | null;
  sourceIdentity: string | null;
  createdAt: string;
}

interface InternalSshKeyView {
  userId: string;
  publicKey: string;
  privateKey?: string;
  fingerprint: string;
  generation: number;
  rotatedAt: string;
}

interface AuditLogView {
  id: string;
  actorId: string | null;
  actorName: string | null;
  actorUsername: string | null;
  actorSnapshot: { id: string | null; type: string | null; name: string | null } | null;
  action: string;
  targetId: string | null;
  targetType: string | null;
  targetName: string | null;
  targetSnapshot: { id: string | null; type: string | null; name: string | null } | null;
  related: unknown[];
  payload: unknown;
  ts: string;
}

interface AuditPageView {
  items: AuditLogView[];
  total: number;
  limit: number;
  offset: number;
}

type TrackedApiFactory = (options?: {
  extraHTTPHeaders?: Record<string, string>;
}) => Promise<APIRequestContext>;

interface StandardPersona {
  user: UserView;
  password: string;
  session: LoginView;
  api: APIRequestContext;
}

const VALID_ED25519_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAFd/vaXN2I0jY5BiWgFdcK4lc66lU/wUQqmKHUgQzt3';
const MANAGE_USERS = 'manage_users';
const MANAGE_GROUPS = 'manage_groups';
const MANAGE_GRANTS = 'manage_grants';
const ALL_CAPABILITIES = [
  MANAGE_USERS,
  MANAGE_GROUPS,
  'manage_servers',
  'manage_images',
  MANAGE_GRANTS,
  'manage_containers_any',
  'view_audit',
  'view_metrics_all',
  'manage_system_settings',
] as const;
const MIB = 1024 * 1024;
let resourceSequence = 0;

function resourceStem(label: string): string {
  resourceSequence += 1;
  return `${currentRunId()}-${label}-${Date.now().toString(36)}-${resourceSequence}`;
}

function usernameFor(stem: string): string {
  return stem.replace(/-/g, '_').slice(0, 64);
}

function passwordFor(stem: string): string {
  return `E2e-${stem.slice(-20)}-Cpu!`;
}

async function createUser(
  adminApi: APIRequestContext,
  label: string,
): Promise<{ user: UserView; password: string }> {
  const stem = resourceStem(label);
  const password = passwordFor(stem);
  const user = await expectJson<UserView>(
    await adminApi.post('/api/admin/users', {
      data: {
        username: usernameFor(stem),
        password,
        displayName: `${stem} user`,
      },
    }),
    201,
  );
  expect(user.username).toBe(usernameFor(stem));
  expect(user.status).toBe('active');
  return { user, password };
}

async function login(
  anonymousApi: APIRequestContext,
  username: string,
  password: string,
): Promise<LoginView> {
  return expectJson<LoginView>(
    await anonymousApi.post('/api/auth/login', {
      data: { username, password },
    }),
  );
}

async function expectStatus(response: APIResponse, status: number): Promise<void> {
  expect(
    response.status(),
    `${response.url()} returned ${response.status()}, expected ${status}; response body withheld`,
  ).toBe(status);
}

async function expectNoContent(response: APIResponse): Promise<void> {
  await expectStatus(response, 204);
  expect(
    (await response.body()).byteLength,
    `${response.url()} returned a non-empty 204 response; response body withheld`,
  ).toBe(0);
}

async function createStandardPersona(
  adminApi: APIRequestContext,
  anonymousApi: APIRequestContext,
  trackedApiFactory: TrackedApiFactory,
  label: string,
): Promise<StandardPersona> {
  const fixture = await createUser(adminApi, label);
  try {
    const session = await login(anonymousApi, fixture.user.username, fixture.password);
    const api = await trackedApiFactory({
      extraHTTPHeaders: { authorization: `Bearer ${session.accessToken}` },
    });
    const me = await expectJson<UserView>(await api.get('/api/auth/me'));
    expect(me.id).toBe(fixture.user.id);
    expect(me.capabilities).toEqual([]);
    return { ...fixture, session, api };
  } catch (error) {
    await deleteUser(adminApi, fixture.user.id);
    throw error;
  }
}

async function waitForAudit(
  adminApi: APIRequestContext,
  targetId: string,
  action: string,
): Promise<AuditLogView> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const page = await expectJson<AuditPageView>(
      await adminApi.get('/api/audit?limit=100&offset=0'),
    );
    const found = page.items.find(
      (entry) => entry.targetId === targetId && entry.action === action,
    );
    if (found) {
      return expectJson<AuditLogView>(await adminApi.get(`/api/audit/${found.id}`));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`audit entry ${action} did not converge for target ${targetId}`);
}

async function settleTasks(adminApi: APIRequestContext, taskIds: readonly string[]): Promise<void> {
  for (const taskId of [...new Set(taskIds)]) {
    await waitForAgentTask(adminApi, taskId, { timeoutMs: 120_000 });
  }
}

async function deleteUser(adminApi: APIRequestContext, userId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await adminApi.get(`/api/admin/users/${userId}`);
    if (existing.status() === 404) return;
    expect(existing.status()).toBe(200);

    const result = await expectJson<{ deleted: boolean; taskIds: string[] }>(
      await adminApi.delete(`/api/admin/users/${userId}`),
    );
    await settleTasks(adminApi, result.taskIds);
    if (result.deleted) return;
  }
  expect((await adminApi.get(`/api/admin/users/${userId}`)).status()).toBe(404);
}

async function runWithCleanupPreservingFailure(
  work: () => Promise<void>,
  cleanup: () => Promise<void>,
): Promise<void> {
  let primaryFailed = false;
  let primaryError: unknown;
  try {
    await work();
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }

  try {
    await cleanup();
  } catch (cleanupError) {
    if (primaryFailed) {
      throw aggregateErrorWithDiagnostics(
        'test behavior and cleanup both failed',
        [primaryError, cleanupError],
      );
    }
    throw cleanupError;
  }

  if (primaryFailed) throw primaryError;
}

async function createGroup(
  adminApi: APIRequestContext,
  label: string,
  capabilities: string[] = [],
): Promise<GroupView> {
  const name = resourceStem(label);
  return expectJson<GroupView>(
    await adminApi.post('/api/admin/groups', {
      data: {
        name,
        description: `${name} live CPU E2E group`,
        priority: 70,
        capabilities,
      },
    }),
    201,
  );
}

async function deleteGroup(adminApi: APIRequestContext, groupId: string): Promise<void> {
  const response = await adminApi.delete(`/api/admin/groups/${groupId}`);
  if (response.status() === 404) return;
  const result = await expectJson<TaskIdsView>(response);
  await settleTasks(adminApi, result.taskIds);
}

async function removeGroupMember(
  adminApi: APIRequestContext,
  groupId: string,
  userId: string,
): Promise<void> {
  const response = await adminApi.delete(`/api/admin/groups/${groupId}/members/${userId}`);
  if (response.status() === 404) return;
  const result = await expectJson<TaskIdsView>(response);
  await settleTasks(adminApi, result.taskIds);
}

function expectExactKeys(value: object, keys: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

function expectActionAvailabilityShape(value: ActionAvailabilityView): void {
  expectExactKeys(value, ['allowed', 'reason', 'missingCapabilities']);
  expect(typeof value.allowed).toBe('boolean');
  expect(value.reason === null || typeof value.reason === 'string').toBe(true);
  expect(value.missingCapabilities).toEqual(expect.any(Array));
  value.missingCapabilities.forEach((capability) => expect(typeof capability).toBe('string'));
}

async function withAttemptAllCleanup<T>(
  label: string,
  work: (registerCleanup: (step: string, cleanup: () => Promise<void>) => void) => Promise<T>,
): Promise<T> {
  const cleanups: Array<{ step: string; cleanup: () => Promise<void> }> = [];
  const registerCleanup = (step: string, cleanup: () => Promise<void>) => {
    cleanups.push({ step, cleanup });
  };
  let result: T | undefined;
  let primaryFailure: { error: unknown } | null = null;
  try {
    result = await work(registerCleanup);
  } catch (error) {
    primaryFailure = { error };
  }
  const cleanupErrors: Error[] = [];
  for (const { step, cleanup } of cleanups.reverse()) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(new Error(`${step}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      }));
    }
  }
  if (primaryFailure !== null || cleanupErrors.length > 0) {
    const errors = [
      ...(primaryFailure === null ? [] : [primaryFailure.error]),
      ...cleanupErrors,
    ];
    throw aggregateErrorWithDiagnostics(
      `${label} failed with complete cleanup attempts`,
      errors,
    );
  }
  return result as T;
}

test.describe('10 authentication and RBAC', () => {
  test(
    'api.auth.login.valid-and-anonymous-admin-denied @smoke',
    coverageCase(
      'auth.identity-rbac.login-valid-anonymous-denied',
      'api.auth.login.valid-and-anonymous-admin-denied',
    ),
    async ({ anonymousApi, adminApi, adminSession }) => {
      const username = requireRuntimeEnv('E2E_ADMIN_USERNAME');
      const password = requireRuntimeEnv('E2E_ADMIN_PASSWORD');
      const login = await expectJson<{
        accessToken: string;
        refreshToken: string;
        user: { id: string; username: string };
      }>(
        await anonymousApi.post('/api/auth/login', {
          data: { username, password },
        }),
      );
      expect(login.accessToken).not.toBe('');
      expect(login.refreshToken).not.toBe('');
      expect(login.user.id).toBe(adminSession.user.id);

      const me = await expectJson<{ id: string; username: string; capabilities: string[] }>(
        await adminApi.get('/api/auth/me'),
      );
      expect(me.id).toBe(adminSession.user.id);
      expect(me.username).toBe(adminSession.user.username);
      expect(me.capabilities.length).toBeGreaterThan(0);

      const denied = await anonymousApi.get('/api/admin/users');
      expect(denied.status()).toBe(401);
    },
  );

  test(
    'api.catalog.users-purpose-safe-projection',
    coverageCase(
      'auth.identity-rbac.catalog-users-projection',
      'api.catalog.users-purpose-safe-projection',
    ),
    async ({ adminApi, adminSession, anonymousApi }) => {
      await expectStatus(await anonymousApi.get('/api/admin/catalog/users'), 401);
      const users = await expectJson<CatalogUserView[]>(
        await adminApi.get('/api/admin/catalog/users'),
      );
      const admin = users.find((user) => user.id === adminSession.user.id);
      expect(admin).toEqual(expect.objectContaining({
        id: adminSession.user.id,
        username: adminSession.user.username,
        status: 'active',
      }));
      users.forEach((user) => {
        expectExactKeys(user, ['id', 'username', 'displayName', 'status']);
        expect(user.status).not.toBe('deleted');
      });
    },
  );

  test(
    'api.catalog.groups-purpose-safe-projection',
    coverageCase(
      'auth.identity-rbac.catalog-groups-projection',
      'api.catalog.groups-purpose-safe-projection',
    ),
    async ({ adminApi, anonymousApi }) => {
      await expectStatus(await anonymousApi.get('/api/admin/catalog/groups'), 401);
      const groups = await expectJson<CatalogGroupView[]>(
        await adminApi.get('/api/admin/catalog/groups'),
      );
      expect(groups.length).toBeGreaterThan(0);
      groups.forEach((group) => {
        expectExactKeys(group, ['id', 'name', 'isSystem']);
        expect(group.id).not.toBe('');
        expect(group.name).not.toBe('');
      });
    },
  );

  test(
    'api.catalog.administration-actions-authoritative-and-purpose-scoped',
    coverageCase(
      'auth.identity-rbac.administration-actions-projection',
      'api.catalog.administration-actions-authoritative-and-purpose-scoped',
    ),
    async ({ adminApi, adminSession, anonymousApi, trackedApiFactory }) => {
      await expectStatus(
        await anonymousApi.get('/api/admin/catalog/administration-actions'),
        401,
      );

      const me = await expectJson<UserView>(await adminApi.get('/api/auth/me'));
      const administrators = me.groups.find((group) => group.name === 'Administrators');
      expect(administrators, 'bootstrap administrator must retain its system group').toBeDefined();

      // Request as a different full-authority actor. This distinguishes the
      // final-administrator rule from the independent self-delete rule.
      const fullEvidence = await withAttemptAllCleanup(
        'full-authority administration-actions evidence',
        async (registerCleanup) => {
        const fullActor = await createUser(adminApi, 'full-action-projection');
        registerCleanup('delete full-authority actor', () => deleteUser(adminApi, fullActor.user.id));
        const fullGroup = await createGroup(adminApi, 'full-action-projection', [...ALL_CAPABILITIES]);
        registerCleanup('delete full-authority group', () => deleteGroup(adminApi, fullGroup.id));
        const added = await expectJson<{ ok: true; taskIds: string[] }>(
          await adminApi.post(`/api/admin/groups/${fullGroup.id}/members`, {
            data: { userId: fullActor.user.id },
          }),
          201,
        );
        registerCleanup(
          'remove full-authority membership',
          () => removeGroupMember(adminApi, fullGroup.id, fullActor.user.id),
        );
        await settleTasks(adminApi, added.taskIds);
        const fullSession = await login(anonymousApi, fullActor.user.username, fullActor.password);
        const fullApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${fullSession.accessToken}` },
        });
        const projection = await expectJson<AdministrationActionsView>(
          await fullApi.get('/api/admin/catalog/administration-actions'),
        );
        expectExactKeys(projection, [
          'actorCapabilities',
          'assignableGroupCapabilities',
          'createUser',
          'createGroup',
          'users',
          'groups',
        ]);
        expect(projection.actorCapabilities).toEqual(expect.arrayContaining([...ALL_CAPABILITIES]));
        expect(projection.assignableGroupCapabilities)
          .toEqual(expect.arrayContaining([...ALL_CAPABILITIES]));
        expect(projection.actorCapabilities).toHaveLength(ALL_CAPABILITIES.length);
        expect(projection.assignableGroupCapabilities).toHaveLength(ALL_CAPABILITIES.length);
        expectActionAvailabilityShape(projection.createUser);
        expectActionAvailabilityShape(projection.createGroup);
        expect(Object.keys(projection.users).length).toBeGreaterThan(0);
        expect(Object.keys(projection.groups).length).toBeGreaterThan(0);
        Object.values(projection.users).forEach((userActions) => {
          expectExactKeys(userActions, ['canAdminister', 'canDelete']);
          expectActionAvailabilityShape(userActions.canAdminister);
          expectActionAvailabilityShape(userActions.canDelete);
        });
        Object.values(projection.groups).forEach((groupActions) => {
          expectExactKeys(groupActions, [
            'canEditMetadata',
            'canEditPriority',
            'canManageMembers',
            'canRemoveMembers',
            'canDelete',
          ]);
          expectActionAvailabilityShape(groupActions.canEditMetadata);
          expectActionAvailabilityShape(groupActions.canEditPriority);
          expectActionAvailabilityShape(groupActions.canManageMembers);
          expectActionAvailabilityShape(groupActions.canDelete);
          Object.values(groupActions.canRemoveMembers).forEach(expectActionAvailabilityShape);
        });
        for (const [groupId, groupActions] of Object.entries(projection.groups)) {
          const currentMembers = await expectJson<GroupMemberView[]>(
            await fullApi.get(`/api/admin/groups/${groupId}/members`),
          );
          expect(Object.keys(groupActions.canRemoveMembers).sort())
            .toEqual(currentMembers.map((member) => member.userId).sort());
        }

        expect(projection.users[adminSession.user.id]?.canDelete).toEqual({
          allowed: false,
          reason: '不能删除最后一个活跃管理员',
          missingCapabilities: [],
        });
        expect(projection.users[fullActor.user.id]?.canDelete).toEqual({
          allowed: false,
          reason: '不能删除当前账号',
          missingCapabilities: [],
        });
        expect(projection.groups[administrators!.id]?.canRemoveMembers[adminSession.user.id])
          .toEqual({
            allowed: false,
            reason: '不能移出最后一个活跃管理员',
            missingCapabilities: [],
          });
        return { fullActor, fullGroup };
      });

      await withAttemptAllCleanup(
        'grant-only administration-actions denial evidence',
        async (registerCleanup) => {
        const fixture = await createUser(adminApi, 'grant-only-action-projection');
        registerCleanup('delete grant-only actor', () => deleteUser(adminApi, fixture.user.id));
        const grantGroup = await createGroup(
          adminApi,
          'grant-only-action-projection',
          [MANAGE_GRANTS],
        );
        registerCleanup('delete grant-only group', () => deleteGroup(adminApi, grantGroup.id));
        const added = await expectJson<{ ok: true; taskIds: string[] }>(
          await adminApi.post(`/api/admin/groups/${grantGroup.id}/members`, {
            data: { userId: fixture.user.id },
          }),
          201,
        );
        registerCleanup(
          'remove grant-only membership',
          () => removeGroupMember(adminApi, grantGroup.id, fixture.user.id),
        );
        await settleTasks(adminApi, added.taskIds);

        const session = await login(anonymousApi, fixture.user.username, fixture.password);
        const grantOnlyApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${session.accessToken}` },
        });
        const grantOnlyMe = await expectJson<UserView>(await grantOnlyApi.get('/api/auth/me'));
        expect(grantOnlyMe.capabilities).toContain(MANAGE_GRANTS);
        expect(grantOnlyMe.capabilities).not.toContain(MANAGE_USERS);
        expect(grantOnlyMe.capabilities).not.toContain(MANAGE_GROUPS);
        const denied = await grantOnlyApi.get('/api/admin/catalog/administration-actions');
        expect(denied.status()).toBe(403);
        const deniedBody = await denied.json() as {
          message: string;
          statusCode: number;
        };
        expectExactKeys(deniedBody, ['message', 'statusCode']);
        expect(deniedBody).toEqual({
          message: 'Forbidden',
          statusCode: 403,
        });
        const currentUsers = await expectJson<UserView[]>(await adminApi.get('/api/admin/users'));
        const currentGroups = await expectJson<GroupView[]>(await adminApi.get('/api/admin/groups'));
        const serialized = JSON.stringify(deniedBody);
        for (const secret of [
          ...currentUsers.flatMap((user) => [user.id, user.username]),
          ...currentGroups.flatMap((group) => [group.id, group.name]),
          fullEvidence.fullActor.user.id,
          fullEvidence.fullActor.user.username,
          fullEvidence.fullGroup.id,
          fullEvidence.fullGroup.name,
          'actorCapabilities',
          'assignableGroupCapabilities',
          'createUser',
          'createGroup',
          'users',
          'groups',
          'canAdminister',
          'canDelete',
          'canEditMetadata',
          'canEditPriority',
          'canManageMembers',
          'canRemoveMembers',
          'allowed',
          'reason',
          'missingCapabilities',
          ...ALL_CAPABILITIES,
        ].filter((value) => value.length > 0)) {
          expect(serialized).not.toContain(secret);
        }
      });
    },
  );

  test(
    'api.catalog.grant-servers-purpose-safe-projection',
    coverageCase(
      'auth.identity-rbac.catalog-grant-servers-projection',
      'api.catalog.grant-servers-purpose-safe-projection',
    ),
    async ({ adminApi, anonymousApi, seedState }) => {
      await expectStatus(await anonymousApi.get('/api/admin/catalog/grant-servers'), 401);
      const servers = await expectJson<CatalogGrantServerView[]>(
        await adminApi.get('/api/admin/catalog/grant-servers'),
      );
      for (const seeded of seedState.servers) {
        expect(servers.map((server) => server.id)).toContain(seeded.serverId);
      }
      servers.forEach((server) => {
        expectExactKeys(server, ['id', 'name', 'slug', 'status', 'runtimeReady', 'gpus']);
        expect(typeof server.runtimeReady).toBe('boolean');
        expect(server.gpus).toEqual(expect.any(Array));
      });
    },
  );

  test(
    'api.catalog.grant-images-purpose-safe-projection',
    coverageCase(
      'auth.identity-rbac.catalog-grant-images-projection',
      'api.catalog.grant-images-purpose-safe-projection',
    ),
    async ({ adminApi, anonymousApi, seedState }) => {
      await expectStatus(await anonymousApi.get('/api/admin/catalog/grant-images'), 401);
      const images = await expectJson<CatalogGrantImageView[]>(
        await adminApi.get('/api/admin/catalog/grant-images'),
      );
      expect(images).toContainEqual(expect.objectContaining({
        id: seedState.image.id,
        isActive: true,
      }));
      images.forEach((image) => {
        expectExactKeys(image, ['id', 'name', 'description', 'isActive']);
        expect(image.isActive).toBe(true);
      });
    },
  );

  test(
    'api.auth.tokens.create-use-delete-owned-resource',
    coverageCase(
      'auth.identity-rbac.api-token-create-list-delete',
      'api.auth.tokens.create-use-delete-owned-resource',
    ),
    async ({ adminApi, adminSession, trackedApiFactory }) => {
      const tokenName = `${currentRunId()}-contract-token`;
      const created = await expectJson<{
        token: { id: string; name: string };
        secret: string;
      }>(await adminApi.post('/api/auth/tokens', { data: { name: tokenName } }), 201);
      let tokenApi: Awaited<ReturnType<typeof trackedApiFactory>> | null = null;
      let deleted = false;

      try {
        tokenApi = await trackedApiFactory({
          extraHTTPHeaders: {
            authorization: `Bearer ${created.secret}`,
          },
        });
        expect(created.token.name).toBe(tokenName);
        expect(created.secret.length).toBeGreaterThan(16);
        const me = await expectJson<{ id: string; username: string }>(
          await tokenApi.get('/api/auth/me'),
        );
        expect(me.id).toBe(adminSession.user.id);
        expect(me.username).toBe(adminSession.user.username);
        const listed = await expectJson<Array<{ id: string; name: string }>>(
          await adminApi.get('/api/auth/tokens'),
        );
        expect(listed).toContainEqual(
          expect.objectContaining({ id: created.token.id, name: tokenName }),
        );
        await expectSuccess(await adminApi.delete(`/api/auth/tokens/${created.token.id}`));
        deleted = true;

        const after = await expectJson<Array<{ id: string }>>(
          await adminApi.get('/api/auth/tokens'),
        );
        expect(after.some((token) => token.id === created.token.id)).toBe(false);
        expect((await tokenApi.get('/api/auth/me')).status()).toBe(401);
      } finally {
        if (!deleted) {
          const cleanup = await adminApi.delete(`/api/auth/tokens/${created.token.id}`);
          expect([204, 404]).toContain(cleanup.status());
        }
      }
    },
  );

  test(
    'api.auth.login.valid-standard-and-invalid-credentials',
    coverageCase(
      'auth.identity-rbac.valid-and-invalid-login',
      'api.auth.login.valid-standard-and-invalid-credentials',
    ),
    async ({ adminApi, adminSession, anonymousApi, trackedApiFactory }) => {
      const persona = await createStandardPersona(
        adminApi,
        anonymousApi,
        trackedApiFactory,
        'login-contract',
      );
      let adminRefreshToken: string | null = null;

      try {
        const adminLogin = await login(
          anonymousApi,
          requireRuntimeEnv('E2E_ADMIN_USERNAME'),
          requireRuntimeEnv('E2E_ADMIN_PASSWORD'),
        );
        adminRefreshToken = adminLogin.refreshToken;
        expect(adminLogin.user.id).toBe(adminSession.user.id);
        expect(adminLogin.user.capabilities.length).toBeGreaterThan(0);

        expect(persona.session.user.id).toBe(persona.user.id);
        expect(persona.session.user.capabilities).toEqual([]);
        await expectStatus(
          await anonymousApi.post('/api/auth/login', {
            data: {
              username: persona.user.username,
              password: `${persona.password}-invalid`,
            },
          }),
          401,
        );
        await expectStatus(
          await anonymousApi.post('/api/auth/login', {
            data: {
              username: usernameFor(resourceStem('missing-login-user')),
              password: persona.password,
            },
          }),
          401,
        );
      } finally {
        try {
          await expectNoContent(
            await persona.api.post('/api/auth/logout', {
              data: { refreshToken: persona.session.refreshToken },
            }),
          );
        } finally {
          try {
            if (adminRefreshToken) {
              await expectNoContent(
                await adminApi.post('/api/auth/logout', {
                  data: { refreshToken: adminRefreshToken },
                }),
              );
            }
          } finally {
            await deleteUser(adminApi, persona.user.id);
          }
        }
      }
    },
  );

  test(
    'api.auth.refresh-rotate-and-logout-revokes',
    coverageCase(
      'auth.identity-rbac.refresh-and-logout',
      'api.auth.refresh-rotate-and-logout-revokes',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory }) => {
      const persona = await createStandardPersona(
        adminApi,
        anonymousApi,
        trackedApiFactory,
        'refresh-logout',
      );
      let activeRefreshToken: string | null = persona.session.refreshToken;
      let activeApi = persona.api;

      try {
        const firstRequestId = refreshRequestId('refresh-logout-first');
        // Logout is authorized by possession of a refresh secret, not by an
        // access JWT. Unknown secrets deliberately receive the same
        // non-disclosing 204 as valid and replayed secrets.
        await expectNoContent(
          await anonymousApi.post('/api/auth/logout', {
            data: { refreshToken: 'unknown-refresh-token' },
          }),
        );
        const rotated = await expectJson<RefreshView>(
          await anonymousApi.post('/api/auth/refresh', {
            data: { refreshToken: persona.session.refreshToken, requestId: firstRequestId },
          }),
        );
        expect(rotated.accessToken.length).toBeGreaterThan(16);
        expect(rotated.refreshToken.length).toBeGreaterThan(16);
        activeRefreshToken = rotated.refreshToken;
        activeApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${rotated.accessToken}` },
        });

        const recovered = await expectJson<RefreshView>(
          await anonymousApi.post('/api/auth/refresh', {
            data: { refreshToken: persona.session.refreshToken, requestId: firstRequestId },
          }),
        );
        expect(recovered.refreshToken).toBe(rotated.refreshToken);

        await expectStatus(
          await anonymousApi.post('/api/auth/refresh', {
            data: {
              refreshToken: persona.session.refreshToken,
              requestId: refreshRequestId('refresh-logout-replay-mismatch'),
            },
          }),
          401,
        );
        expect((await expectJson<UserView>(await activeApi.get('/api/auth/me'))).id).toBe(
          persona.user.id,
        );
        // The captured predecessor remains a selector for exactly the same
        // in-place session row, so it must delete the current successor even
        // without an access JWT.
        await expectNoContent(
          await anonymousApi.post('/api/auth/logout', {
            data: { refreshToken: persona.session.refreshToken },
          }),
        );
        activeRefreshToken = null;
        await expectStatus(
          await anonymousApi.post('/api/auth/refresh', {
            data: {
              refreshToken: rotated.refreshToken,
              requestId: refreshRequestId('refresh-logout-after-logout'),
            },
          }),
          401,
        );
        await expectNoContent(
          await anonymousApi.post('/api/auth/logout', {
            data: { refreshToken: persona.session.refreshToken },
          }),
        );
        await expectNoContent(
          await anonymousApi.post('/api/auth/logout', {
            data: { refreshToken: rotated.refreshToken },
          }),
        );
      } finally {
        try {
          if (activeRefreshToken) {
            await expectNoContent(
              await activeApi.post('/api/auth/logout', {
                data: { refreshToken: activeRefreshToken },
              }),
            );
          }
        } finally {
          await deleteUser(adminApi, persona.user.id);
        }
      }
    },
  );

  test(
    'api.auth.tokens.standard-user-lifecycle-and-isolation',
    coverageCase(
      'auth.identity-rbac.api-tokens',
      'api.auth.tokens.standard-user-lifecycle-and-isolation',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory }) => {
      const owner = await createStandardPersona(
        adminApi,
        anonymousApi,
        trackedApiFactory,
        'token-owner',
      );
      let other: StandardPersona | null = null;
      let token: ApiTokenView | null = null;

      try {
        other = await createStandardPersona(
          adminApi,
          anonymousApi,
          trackedApiFactory,
          'token-other',
        );
        await expectStatus(await anonymousApi.get('/api/auth/tokens'), 401);
        expect((await owner.api.get('/api/admin/users')).status()).toBe(403);

        const tokenName = `${currentRunId()}-standard-token`;
        token = await expectJson<ApiTokenView>(
          await owner.api.post('/api/auth/tokens', {
            data: { name: tokenName },
          }),
          201,
        );
        expect(token.token.name).toBe(tokenName);
        expect(token.secret.length).toBeGreaterThan(32);

        const tokenApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${token.secret}` },
        });
        expect((await expectJson<UserView>(await tokenApi.get('/api/auth/me'))).id).toBe(
          owner.user.id,
        );
        const ownerTokens = await expectJson<Array<Record<string, unknown>>>(
          await owner.api.get('/api/auth/tokens'),
        );
        const listed = ownerTokens.find((entry) => entry.id === token?.token.id);
        expect(listed).toBeDefined();
        expect(listed?.name).toBe(tokenName);
        expect(listed).not.toHaveProperty('secret');

        const adminTokens = await expectJson<Array<{ id: string }>>(
          await adminApi.get('/api/auth/tokens'),
        );
        expect(adminTokens.some((entry) => entry.id === token?.token.id)).toBe(false);
        await expectStatus(await other.api.delete(`/api/auth/tokens/${token.token.id}`), 404);
        await expectNoContent(await owner.api.delete(`/api/auth/tokens/${token.token.id}`));
        token = null;
        expect(
          (await expectJson<Array<{ id: string }>>(await owner.api.get('/api/auth/tokens'))).some(
            (entry) => entry.id === listed?.id,
          ),
        ).toBe(false);
        await expectStatus(await tokenApi.get('/api/auth/me'), 401);
      } finally {
        try {
          if (token) {
            const response = await owner.api.delete(`/api/auth/tokens/${token.token.id}`);
            expect([204, 404]).toContain(response.status());
          }
        } finally {
          if (other) await deleteUser(adminApi, other.user.id);
          await deleteUser(adminApi, owner.user.id);
        }
      }
    },
  );

  test(
    'api.auth-rbac.audit.admin-visible-standard-and-anonymous-denied',
    coverageCase(
      'auth.identity-rbac.audit',
      'api.auth-rbac.audit.admin-visible-standard-and-anonymous-denied',
    ),
    async ({ adminApi, adminSession, anonymousApi, trackedApiFactory }) => {
      const persona = await createStandardPersona(
        adminApi,
        anonymousApi,
        trackedApiFactory,
        'audit-denied',
      );
      let group: GroupView | null = null;

      try {
        await expectStatus(await anonymousApi.get('/api/audit?limit=1&offset=0'), 401);
        await expectStatus(await persona.api.get('/api/audit?limit=1&offset=0'), 403);

        group = await createGroup(adminApi, 'audit-target');
        const audit = await waitForAudit(adminApi, group.id, 'group.create');
        expect(audit.actorId).toBe(adminSession.user.id);
        expect(audit.actorUsername).toBe(adminSession.user.username);
        expect(audit.action).toBe('group.create');
        expect(audit.targetId).toBe(group.id);
        expect(audit.targetType).toBe('group');
        expect(audit.targetSnapshot).toEqual(
          expect.objectContaining({
            id: group.id,
            type: 'group',
            name: group.name,
          }),
        );
        expect(Number.isNaN(Date.parse(audit.ts))).toBe(false);
      } finally {
        try {
          if (group) await deleteGroup(adminApi, group.id);
        } finally {
          await deleteUser(adminApi, persona.user.id);
        }
      }
    },
  );

  test(
    'api.auth.logout-exact-contract',
    coverageCase('auth.identity-rbac.http.post.api-auth-logout', 'api.auth.logout-exact-contract'),
    async ({ adminApi, anonymousApi, trackedApiFactory }) => {
      const persona = await createStandardPersona(
        adminApi,
        anonymousApi,
        trackedApiFactory,
        'logout-route',
      );
      let loggedOut = false;

      try {
        await expectStatus(
          await anonymousApi.post('/api/auth/logout', {
            data: {},
          }),
          400,
        );
        await expectNoContent(
          await anonymousApi.post('/api/auth/logout', {
            data: { refreshToken: 'unknown-refresh-token' },
          }),
        );
        await expectNoContent(
          await anonymousApi.post('/api/auth/logout', {
            data: { refreshToken: persona.session.refreshToken },
          }),
        );
        loggedOut = true;
        await expectNoContent(
          await anonymousApi.post('/api/auth/logout', {
            data: { refreshToken: persona.session.refreshToken },
          }),
        );
        await expectStatus(
          await anonymousApi.post('/api/auth/refresh', {
            data: {
              refreshToken: persona.session.refreshToken,
              requestId: refreshRequestId('logout-route-after-logout'),
            },
          }),
          401,
        );
      } finally {
        try {
          if (!loggedOut) {
            await expectNoContent(
              await persona.api.post('/api/auth/logout', {
                data: { refreshToken: persona.session.refreshToken },
              }),
            );
          }
        } finally {
          await deleteUser(adminApi, persona.user.id);
        }
      }
    },
  );

  test(
    'api.auth.refresh-exact-contract',
    coverageCase(
      'auth.identity-rbac.http.post.api-auth-refresh',
      'api.auth.refresh-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory }) => {
      const persona = await createStandardPersona(
        adminApi,
        anonymousApi,
        trackedApiFactory,
        'refresh-route',
      );
      let activeRefreshToken: string | null = persona.session.refreshToken;
      let activeApi = persona.api;

      try {
        await expectStatus(
          await anonymousApi.post('/api/auth/refresh', {
            data: { refreshToken: persona.session.refreshToken },
          }),
          400,
        );
        await expectStatus(
          await anonymousApi.post('/api/auth/refresh', {
            data: {
              refreshToken: 'invalid-refresh-token',
              requestId: refreshRequestId('refresh-route-invalid-anonymous'),
            },
          }),
          401,
        );
        await expectStatus(
          await persona.api.post('/api/auth/refresh', {
            data: {
              refreshToken: 'invalid-refresh-token',
              requestId: refreshRequestId('refresh-route-invalid-authenticated'),
            },
          }),
          401,
        );

        const requestId = refreshRequestId('refresh-route-valid');
        const rotated = await expectJson<RefreshView>(
          await anonymousApi.post('/api/auth/refresh', {
            data: { refreshToken: persona.session.refreshToken, requestId },
          }),
        );
        expect(rotated.accessToken.length).toBeGreaterThan(16);
        expect(rotated.refreshToken.length).toBeGreaterThan(16);
        activeRefreshToken = rotated.refreshToken;
        activeApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${rotated.accessToken}` },
        });
        expect((await expectJson<UserView>(await activeApi.get('/api/auth/me'))).id).toBe(
          persona.user.id,
        );
        const recovered = await expectJson<RefreshView>(
          await anonymousApi.post('/api/auth/refresh', {
            data: { refreshToken: persona.session.refreshToken, requestId },
          }),
        );
        expect(recovered.refreshToken).toBe(rotated.refreshToken);
        await expectStatus(
          await anonymousApi.post('/api/auth/refresh', {
            data: {
              refreshToken: persona.session.refreshToken,
              requestId: refreshRequestId('refresh-route-replay-mismatch'),
            },
          }),
          401,
        );
      } finally {
        try {
          if (activeRefreshToken) {
            await expectNoContent(
              await activeApi.post('/api/auth/logout', {
                data: { refreshToken: activeRefreshToken },
              }),
            );
          }
        } finally {
          await deleteUser(adminApi, persona.user.id);
        }
      }
    },
  );

  test(
    'api.auth-rbac.groups.delete-mount-source-grant-exact-contract',
    coverageCase(
      'auth.identity-rbac.http.delete.api-admin-groups-by-id-mount-source-grants-by-sourcekind-by-sourceid',
      'api.auth-rbac.groups.delete-mount-source-grant-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      const persona = await createStandardPersona(
        adminApi,
        anonymousApi,
        trackedApiFactory,
        'group-mount-delete',
      );
      const source = seedState.mountSourceGrants[0];
      let group: GroupView | null = null;
      let grantCreated = false;

      try {
        group = await createGroup(adminApi, 'group-mount-delete');
        const created = await expectJson<MountSourceGrantView>(
          await adminApi.post(`/api/admin/groups/${group.id}/mount-source-grants`, {
            data: {
              sourceKind: 'local',
              sourceId: source.diskId,
              serverId: source.serverId,
            },
          }),
          201,
        );
        grantCreated = true;
        expect(created).toEqual(
          expect.objectContaining({
            scope: 'group',
            scopeId: group.id,
            sourceKind: 'local',
            sourceId: source.diskId,
            serverId: source.serverId,
            sourceIdentity: source.sourceIdentity,
          }),
        );

        const path =
          `/api/admin/groups/${group.id}/mount-source-grants/local/${source.diskId}` +
          `?serverId=${source.serverId}`;
        await expectStatus(await anonymousApi.delete(path), 401);
        await expectStatus(await persona.api.delete(path), 403);
        await expectNoContent(await adminApi.delete(path));
        grantCreated = false;
        const after = await expectJson<MountSourceGrantView[]>(
          await adminApi.get(`/api/admin/groups/${group.id}/mount-source-grants`),
        );
        expect(after.some((entry) => entry.id === created.id)).toBe(false);
      } finally {
        try {
          if (group && grantCreated) {
            await expectNoContent(
              await adminApi.delete(
                `/api/admin/groups/${group.id}/mount-source-grants/local/${source.diskId}` +
                  `?serverId=${source.serverId}`,
              ),
            );
          }
        } finally {
          try {
            if (group) await deleteGroup(adminApi, group.id);
          } finally {
            await deleteUser(adminApi, persona.user.id);
          }
        }
      }
    },
  );

  test(
    'api.auth-rbac.groups.list-mount-source-grants-exact-contract',
    coverageCase(
      'auth.identity-rbac.http.get.api-admin-groups-by-id-mount-source-grants',
      'api.auth-rbac.groups.list-mount-source-grants-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      const persona = await createStandardPersona(
        adminApi,
        anonymousApi,
        trackedApiFactory,
        'group-mount-list',
      );
      const source = seedState.mountSourceGrants[0];
      let group: GroupView | null = null;
      let grantCreated = false;

      try {
        group = await createGroup(adminApi, 'group-mount-list');
        const created = await expectJson<MountSourceGrantView>(
          await adminApi.post(`/api/admin/groups/${group.id}/mount-source-grants`, {
            data: {
              sourceKind: 'local',
              sourceId: source.diskId,
              serverId: source.serverId,
            },
          }),
          201,
        );
        grantCreated = true;

        const path = `/api/admin/groups/${group.id}/mount-source-grants`;
        await expectStatus(await anonymousApi.get(path), 401);
        await expectStatus(await persona.api.get(path), 403);
        const listed = await expectJson<MountSourceGrantView[]>(await adminApi.get(path));
        expect(listed).toContainEqual(
          expect.objectContaining({
            id: created.id,
            scope: 'group',
            scopeId: group.id,
            sourceKind: 'local',
            sourceId: source.diskId,
            serverId: source.serverId,
            sourceIdentity: source.sourceIdentity,
          }),
        );
      } finally {
        try {
          if (group && grantCreated) {
            await expectNoContent(
              await adminApi.delete(
                `/api/admin/groups/${group.id}/mount-source-grants/local/${source.diskId}` +
                  `?serverId=${source.serverId}`,
              ),
            );
          }
        } finally {
          try {
            if (group) await deleteGroup(adminApi, group.id);
          } finally {
            await deleteUser(adminApi, persona.user.id);
          }
        }
      }
    },
  );

  test(
    'api.auth-rbac.groups.sync-image-grant-servers-exact-contract',
    coverageCase(
      'auth.identity-rbac.http.post.api-admin-groups-by-id-image-grants-by-imageid-sync-servers',
      'api.auth-rbac.groups.sync-image-grant-servers-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      const persona = await createStandardPersona(
        adminApi,
        anonymousApi,
        trackedApiFactory,
        'group-image-sync',
      );
      const serverIds = seedState.servers.map((server) => server.serverId);
      let group: GroupView | null = null;
      let synced = false;

      try {
        group = await createGroup(adminApi, 'group-image-sync');
        const path = `/api/admin/groups/${group.id}/image-grants/${seedState.image.id}/sync-servers`;
        const body = { serverIds };
        await expectStatus(await anonymousApi.post(path, { data: body }), 401);
        await expectStatus(await persona.api.post(path, { data: body }), 403);

        const grants = await expectJson<ImageGrantView[]>(
          await adminApi.post(path, { data: body }),
          201,
        );
        synced = true;
        expect(grants).toHaveLength(serverIds.length);
        expect(new Set(grants.map((grant) => grant.serverId))).toEqual(new Set(serverIds));
        expect(
          grants.every(
            (grant) =>
              grant.scope === 'group' &&
              grant.scopeId === group?.id &&
              grant.imageId === seedState.image.id,
          ),
        ).toBe(true);

        const persisted = await expectJson<ImageGrantView[]>(
          await adminApi.get(`/api/admin/groups/${group.id}/image-grants`),
        );
        expect(
          new Set(
            persisted
              .filter((grant) => grant.imageId === seedState.image.id)
              .map((grant) => grant.serverId),
          ),
        ).toEqual(new Set(serverIds));
      } finally {
        try {
          if (group && synced) {
            for (const serverId of serverIds) {
              await expectNoContent(
                await adminApi.delete(
                  `/api/admin/groups/${group.id}/image-grants/${seedState.image.id}/${serverId}`,
                ),
              );
            }
          }
        } finally {
          try {
            if (group) await deleteGroup(adminApi, group.id);
          } finally {
            await deleteUser(adminApi, persona.user.id);
          }
        }
      }
    },
  );

  test(
    'api.auth-rbac.groups.upsert-mount-source-grant-exact-contract',
    coverageCase(
      'auth.identity-rbac.http.post.api-admin-groups-by-id-mount-source-grants',
      'api.auth-rbac.groups.upsert-mount-source-grant-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      const persona = await createStandardPersona(
        adminApi,
        anonymousApi,
        trackedApiFactory,
        'group-mount-upsert',
      );
      const source = seedState.mountSourceGrants[0];
      const body = {
        sourceKind: 'local' as const,
        sourceId: source.diskId,
        serverId: source.serverId,
      };
      let group: GroupView | null = null;
      let grant: MountSourceGrantView | null = null;

      try {
        group = await createGroup(adminApi, 'group-mount-upsert');
        const path = `/api/admin/groups/${group.id}/mount-source-grants`;
        await expectStatus(await anonymousApi.post(path, { data: body }), 401);
        await expectStatus(await persona.api.post(path, { data: body }), 403);
        grant = await expectJson<MountSourceGrantView>(
          await adminApi.post(path, { data: body }),
          201,
        );
        expect(grant).toEqual(
          expect.objectContaining({
            scope: 'group',
            scopeId: group.id,
            sourceKind: 'local',
            sourceId: source.diskId,
            serverId: source.serverId,
            sourceIdentity: source.sourceIdentity,
          }),
        );
        const persisted = await expectJson<MountSourceGrantView[]>(await adminApi.get(path));
        expect(persisted.some((entry) => entry.id === grant?.id)).toBe(true);
      } finally {
        try {
          if (group && grant) {
            await expectNoContent(
              await adminApi.delete(
                `/api/admin/groups/${group.id}/mount-source-grants/local/${source.diskId}` +
                  `?serverId=${source.serverId}`,
              ),
            );
          }
        } finally {
          try {
            if (group) await deleteGroup(adminApi, group.id);
          } finally {
            await deleteUser(adminApi, persona.user.id);
          }
        }
      }
    },
  );

  test(
    'api.auth-rbac.users.delete-image-grant-exact-contract',
    coverageCase(
      'auth.identity-rbac.http.delete.api-admin-users-by-userid-image-grants-by-imageid-by-serverid',
      'api.auth-rbac.users.delete-image-grant-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      const persona = await createStandardPersona(
        adminApi,
        anonymousApi,
        trackedApiFactory,
        'user-image-delete',
      );
      const serverId = seedState.servers[0].serverId;
      let grant: ImageGrantView | null = null;

      try {
        grant = await expectJson<ImageGrantView>(
          await adminApi.post(`/api/admin/users/${persona.user.id}/image-grants`, {
            data: { imageId: seedState.image.id, serverId },
          }),
          201,
        );
        const path = `/api/admin/users/${persona.user.id}/image-grants/${seedState.image.id}/${serverId}`;
        await expectStatus(await anonymousApi.delete(path), 401);
        await expectStatus(await persona.api.delete(path), 403);
        await expectNoContent(await adminApi.delete(path));
        grant = null;
        const persisted = await expectJson<ImageGrantView[]>(
          await adminApi.get(`/api/admin/users/${persona.user.id}/image-grants`),
        );
        expect(
          persisted.some(
            (entry) => entry.imageId === seedState.image.id && entry.serverId === serverId,
          ),
        ).toBe(false);
      } finally {
        try {
          if (grant) {
            await expectNoContent(
              await adminApi.delete(
                `/api/admin/users/${persona.user.id}/image-grants/${seedState.image.id}/${serverId}`,
              ),
            );
          }
        } finally {
          await deleteUser(adminApi, persona.user.id);
        }
      }
    },
  );

  test(
    'api.auth-rbac.users.delete-mount-source-grant-exact-contract',
    coverageCase(
      'auth.identity-rbac.http.delete.api-admin-users-by-userid-mount-source-grants-by-sourcekind-by-sourceid',
      'api.auth-rbac.users.delete-mount-source-grant-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      const persona = await createStandardPersona(
        adminApi,
        anonymousApi,
        trackedApiFactory,
        'user-mount-delete',
      );
      const source = seedState.mountSourceGrants[0];
      let grant: MountSourceGrantView | null = null;

      try {
        grant = await expectJson<MountSourceGrantView>(
          await adminApi.post(`/api/admin/users/${persona.user.id}/mount-source-grants`, {
            data: {
              sourceKind: 'local',
              sourceId: source.diskId,
              serverId: source.serverId,
            },
          }),
          201,
        );
        const path =
          `/api/admin/users/${persona.user.id}/mount-source-grants/local/${source.diskId}` +
          `?serverId=${source.serverId}`;
        await expectStatus(await anonymousApi.delete(path), 401);
        await expectStatus(await persona.api.delete(path), 403);
        await expectNoContent(await adminApi.delete(path));
        grant = null;
        const persisted = await expectJson<MountSourceGrantView[]>(
          await adminApi.get(`/api/admin/users/${persona.user.id}/mount-source-grants`),
        );
        expect(
          persisted.some(
            (entry) =>
              entry.sourceKind === 'local' &&
              entry.sourceId === source.diskId &&
              entry.serverId === source.serverId,
          ),
        ).toBe(false);
      } finally {
        try {
          if (grant) {
            await expectNoContent(
              await adminApi.delete(
                `/api/admin/users/${persona.user.id}/mount-source-grants/local/${source.diskId}` +
                  `?serverId=${source.serverId}`,
              ),
            );
          }
        } finally {
          await deleteUser(adminApi, persona.user.id);
        }
      }
    },
  );

  test(
    'api.auth-rbac.users.list-image-grants-exact-contract',
    coverageCase(
      'auth.identity-rbac.http.get.api-admin-users-by-userid-image-grants',
      'api.auth-rbac.users.list-image-grants-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      const persona = await createStandardPersona(
        adminApi,
        anonymousApi,
        trackedApiFactory,
        'user-image-list',
      );
      const serverId = seedState.servers[0].serverId;
      let grant: ImageGrantView | null = null;

      try {
        grant = await expectJson<ImageGrantView>(
          await adminApi.post(`/api/admin/users/${persona.user.id}/image-grants`, {
            data: { imageId: seedState.image.id, serverId },
          }),
          201,
        );
        const path = `/api/admin/users/${persona.user.id}/image-grants`;
        await expectStatus(await anonymousApi.get(path), 401);
        await expectStatus(await persona.api.get(path), 403);
        const listed = await expectJson<ImageGrantView[]>(await adminApi.get(path));
        expect(listed).toContainEqual(
          expect.objectContaining({
            id: grant.id,
            scope: 'user',
            scopeId: persona.user.id,
            imageId: seedState.image.id,
            serverId,
          }),
        );
      } finally {
        try {
          if (grant) {
            await expectNoContent(
              await adminApi.delete(
                `/api/admin/users/${persona.user.id}/image-grants/${seedState.image.id}/${serverId}`,
              ),
            );
          }
        } finally {
          await deleteUser(adminApi, persona.user.id);
        }
      }
    },
  );

  test(
    'api.auth-rbac.users.list-mount-source-grants-exact-contract',
    coverageCase(
      'auth.identity-rbac.http.get.api-admin-users-by-userid-mount-source-grants',
      'api.auth-rbac.users.list-mount-source-grants-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      const persona = await createStandardPersona(
        adminApi,
        anonymousApi,
        trackedApiFactory,
        'user-mount-list',
      );
      const source = seedState.mountSourceGrants[0];
      let grant: MountSourceGrantView | null = null;

      try {
        grant = await expectJson<MountSourceGrantView>(
          await adminApi.post(`/api/admin/users/${persona.user.id}/mount-source-grants`, {
            data: {
              sourceKind: 'local',
              sourceId: source.diskId,
              serverId: source.serverId,
            },
          }),
          201,
        );
        const path = `/api/admin/users/${persona.user.id}/mount-source-grants`;
        await expectStatus(await anonymousApi.get(path), 401);
        await expectStatus(await persona.api.get(path), 403);
        const listed = await expectJson<MountSourceGrantView[]>(await adminApi.get(path));
        expect(listed).toContainEqual(
          expect.objectContaining({
            id: grant.id,
            scope: 'user',
            scopeId: persona.user.id,
            sourceKind: 'local',
            sourceId: source.diskId,
            serverId: source.serverId,
            sourceIdentity: source.sourceIdentity,
          }),
        );
      } finally {
        try {
          if (grant) {
            await expectNoContent(
              await adminApi.delete(
                `/api/admin/users/${persona.user.id}/mount-source-grants/local/${source.diskId}` +
                  `?serverId=${source.serverId}`,
              ),
            );
          }
        } finally {
          await deleteUser(adminApi, persona.user.id);
        }
      }
    },
  );

  test(
    'api.auth-rbac.users.add-image-grant-exact-contract',
    coverageCase(
      'auth.identity-rbac.http.post.api-admin-users-by-userid-image-grants',
      'api.auth-rbac.users.add-image-grant-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      const persona = await createStandardPersona(
        adminApi,
        anonymousApi,
        trackedApiFactory,
        'user-image-add',
      );
      const serverId = seedState.servers[0].serverId;
      const path = `/api/admin/users/${persona.user.id}/image-grants`;
      const body = { imageId: seedState.image.id, serverId };
      let grant: ImageGrantView | null = null;

      try {
        await expectStatus(await anonymousApi.post(path, { data: body }), 401);
        await expectStatus(await persona.api.post(path, { data: body }), 403);
        grant = await expectJson<ImageGrantView>(await adminApi.post(path, { data: body }), 201);
        expect(grant).toEqual(
          expect.objectContaining({
            scope: 'user',
            scopeId: persona.user.id,
            imageId: seedState.image.id,
            serverId,
          }),
        );
        const persisted = await expectJson<ImageGrantView[]>(await adminApi.get(path));
        expect(persisted.some((entry) => entry.id === grant?.id)).toBe(true);
      } finally {
        try {
          if (grant) {
            await expectNoContent(
              await adminApi.delete(
                `/api/admin/users/${persona.user.id}/image-grants/${seedState.image.id}/${serverId}`,
              ),
            );
          }
        } finally {
          await deleteUser(adminApi, persona.user.id);
        }
      }
    },
  );

  test(
    'api.auth-rbac.users.upsert-mount-source-grant-exact-contract',
    coverageCase(
      'auth.identity-rbac.http.post.api-admin-users-by-userid-mount-source-grants',
      'api.auth-rbac.users.upsert-mount-source-grant-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      const persona = await createStandardPersona(
        adminApi,
        anonymousApi,
        trackedApiFactory,
        'user-mount-upsert',
      );
      const source = seedState.mountSourceGrants[0];
      const path = `/api/admin/users/${persona.user.id}/mount-source-grants`;
      const body = {
        sourceKind: 'local' as const,
        sourceId: source.diskId,
        serverId: source.serverId,
      };
      let grant: MountSourceGrantView | null = null;

      try {
        await expectStatus(await anonymousApi.post(path, { data: body }), 401);
        await expectStatus(await persona.api.post(path, { data: body }), 403);
        grant = await expectJson<MountSourceGrantView>(
          await adminApi.post(path, { data: body }),
          201,
        );
        expect(grant).toEqual(
          expect.objectContaining({
            scope: 'user',
            scopeId: persona.user.id,
            sourceKind: 'local',
            sourceId: source.diskId,
            serverId: source.serverId,
            sourceIdentity: source.sourceIdentity,
          }),
        );
        const persisted = await expectJson<MountSourceGrantView[]>(await adminApi.get(path));
        expect(persisted.some((entry) => entry.id === grant?.id)).toBe(true);
      } finally {
        try {
          if (grant) {
            await expectNoContent(
              await adminApi.delete(
                `/api/admin/users/${persona.user.id}/mount-source-grants/local/${source.diskId}` +
                  `?serverId=${source.serverId}`,
              ),
            );
          }
        } finally {
          await deleteUser(adminApi, persona.user.id);
        }
      }
    },
  );

  test(
    'api.auth-rbac.users.get-internal-ssh-key-exact-contract',
    coverageCase(
      'auth.identity-rbac.http.get.api-admin-users-by-id-internal-ssh-key',
      'api.auth-rbac.users.get-internal-ssh-key-exact-contract',
    ),
    async ({ adminApi, adminSession, anonymousApi, trackedApiFactory }) => {
      const persona = await createStandardPersona(
        adminApi,
        anonymousApi,
        trackedApiFactory,
        'internal-key-get',
      );
      const path = `/api/admin/users/${persona.user.id}/internal-ssh-key`;

      try {
        await expectStatus(await anonymousApi.get(path), 401);
        await expectStatus(await persona.api.get(path), 403);

        const publicView = await expectJson<InternalSshKeyView>(await adminApi.get(path));
        expect(publicView.userId).toBe(persona.user.id);
        expect(publicView.publicKey.startsWith('ssh-ed25519 ')).toBe(true);
        expect(publicView.fingerprint.length).toBeGreaterThan(16);
        expect(publicView.generation).toBe(1);
        expect(publicView).not.toHaveProperty('privateKey');
        expect(Number.isNaN(Date.parse(publicView.rotatedAt))).toBe(false);

        const privateView = await expectJson<InternalSshKeyView>(
          await adminApi.get(`${path}?includePrivate=true`),
        );
        expect(privateView.userId).toBe(publicView.userId);
        expect(privateView.publicKey).toBe(publicView.publicKey);
        expect(privateView.fingerprint).toBe(publicView.fingerprint);
        expect(privateView.generation).toBe(publicView.generation);
        expect(typeof privateView.privateKey).toBe('string');
        expect(privateView.privateKey?.length ?? 0).toBeGreaterThan(64);

        const audit = await waitForAudit(adminApi, persona.user.id, 'user.internal_ssh_key.view');
        expect(audit.actorId).toBe(adminSession.user.id);
        expect(audit.targetType).toBe('user');
      } finally {
        await deleteUser(adminApi, persona.user.id);
      }
    },
  );

  test(
    'api.auth-rbac.users.rotate-internal-ssh-key-exact-contract',
    coverageCase(
      'auth.identity-rbac.http.post.api-admin-users-by-id-internal-ssh-key-rotate',
      'api.auth-rbac.users.rotate-internal-ssh-key-exact-contract',
    ),
    async ({ adminApi, adminSession, anonymousApi, trackedApiFactory }) => {
      const persona = await createStandardPersona(
        adminApi,
        anonymousApi,
        trackedApiFactory,
        'internal-key-rotate',
      );
      const getPath = `/api/admin/users/${persona.user.id}/internal-ssh-key`;
      const rotatePath = `${getPath}/rotate`;

      try {
        const before = await expectJson<InternalSshKeyView>(await adminApi.get(getPath));
        await expectStatus(await anonymousApi.post(rotatePath), 401);
        await expectStatus(await persona.api.post(rotatePath), 403);

        const rotated = await expectJson<InternalSshKeyView>(await adminApi.post(rotatePath), 201);
        expect(rotated.userId).toBe(persona.user.id);
        expect(rotated.generation).toBe(before.generation + 1);
        expect(rotated.publicKey === before.publicKey).toBe(false);
        expect(rotated.fingerprint === before.fingerprint).toBe(false);
        expect(typeof rotated.privateKey).toBe('string');
        expect(rotated.privateKey?.length ?? 0).toBeGreaterThan(64);

        const persisted = await expectJson<InternalSshKeyView>(await adminApi.get(getPath));
        expect(persisted.userId).toBe(rotated.userId);
        expect(persisted.publicKey).toBe(rotated.publicKey);
        expect(persisted.fingerprint).toBe(rotated.fingerprint);
        expect(persisted.generation).toBe(rotated.generation);
        expect(persisted).not.toHaveProperty('privateKey');

        const audit = await waitForAudit(adminApi, persona.user.id, 'user.internal_ssh_key.rotate');
        expect(audit.actorId).toBe(adminSession.user.id);
        expect(audit.targetType).toBe('user');
      } finally {
        await deleteUser(adminApi, persona.user.id);
      }
    },
  );

  test(
    'api.auth-rbac.users-ssh.lifecycle-and-denial',
    coverageCase(
      'auth.identity-rbac.users-and-ssh-keys',
      'api.auth-rbac.users-ssh.lifecycle-and-denial',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory }) => {
      const fixture = await createUser(adminApi, 'users-ssh');
      const createdKeyIds = new Set<string>();

      try {
        const session = await login(anonymousApi, fixture.user.username, fixture.password);
        const userApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${session.accessToken}` },
        });

        const own = await expectJson<UserView>(await userApi.get(`/api/users/${fixture.user.id}`));
        expect(own.id).toBe(fixture.user.id);
        expect(own.capabilities).toEqual([]);
        expect(own.groups.map((group) => group.name)).toContain('Users');
        expect((await userApi.get('/api/admin/users')).status()).toBe(403);

        const listed = await expectJson<UserView[]>(await adminApi.get('/api/admin/users'));
        expect(listed).toContainEqual(expect.objectContaining({ id: fixture.user.id }));
        const byId = await expectJson<UserView>(
          await adminApi.get(`/api/admin/users/${fixture.user.id}`),
        );
        expect(byId.username).toBe(fixture.user.username);

        const selfUpdated = await expectJson<UserView>(
          await userApi.patch(`/api/users/${fixture.user.id}`, {
            data: { displayName: `${fixture.user.username} self-updated` },
          }),
        );
        expect(selfUpdated.displayName).toContain('self-updated');
        const adminUpdated = await expectJson<UserView>(
          await adminApi.patch(`/api/admin/users/${fixture.user.id}`, {
            data: { displayName: `${fixture.user.username} admin-verified` },
          }),
        );
        expect(adminUpdated.displayName).toContain('admin-verified');

        const adminDeletedKey = await expectJson<SshKeyView>(
          await userApi.post(`/api/users/${fixture.user.id}/ssh-keys`, {
            data: { name: `${currentRunId()}-admin-delete-key`, keyText: VALID_ED25519_KEY },
          }),
          201,
        );
        createdKeyIds.add(adminDeletedKey.id);

        const selfKeys = await expectJson<SshKeyView[]>(
          await userApi.get(`/api/users/${fixture.user.id}/ssh-keys`),
        );
        expect(selfKeys.map((key) => key.id)).toContain(adminDeletedKey.id);
        const adminKeys = await expectJson<SshKeyView[]>(
          await adminApi.get(`/api/admin/users/${fixture.user.id}/ssh-keys`),
        );
        expect(adminKeys.map((key) => key.id)).toContain(adminDeletedKey.id);

        await expectSuccess(
          await adminApi.delete(
            `/api/admin/users/${fixture.user.id}/ssh-keys/${adminDeletedKey.id}`,
          ),
        );
        createdKeyIds.delete(adminDeletedKey.id);

        // Fingerprints are unique per user, so prove both delete personas by
        // re-adding the same valid public key only after the admin deletion.
        const selfDeletedKey = await expectJson<SshKeyView>(
          await userApi.post(`/api/users/${fixture.user.id}/ssh-keys`, {
            data: { name: `${currentRunId()}-self-delete-key`, keyText: VALID_ED25519_KEY },
          }),
          201,
        );
        createdKeyIds.add(selfDeletedKey.id);
        await expectSuccess(
          await userApi.delete(`/api/users/${fixture.user.id}/ssh-keys/${selfDeletedKey.id}`),
        );
        createdKeyIds.delete(selfDeletedKey.id);
        expect(
          await expectJson<SshKeyView[]>(
            await userApi.get(`/api/users/${fixture.user.id}/ssh-keys`),
          ),
        ).toEqual([]);
      } finally {
        for (const keyId of createdKeyIds) {
          const response = await adminApi.delete(
            `/api/admin/users/${fixture.user.id}/ssh-keys/${keyId}`,
          );
          expect([204, 404]).toContain(response.status());
        }
        await deleteUser(adminApi, fixture.user.id);
      }
    },
  );

  test(
    'api.auth-rbac.groups.membership-capability-lifecycle',
    coverageCase(
      'auth.identity-rbac.groups-and-nested-grants',
      'api.auth-rbac.groups.membership-capability-lifecycle',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory }) => {
      const fixture = await createUser(adminApi, 'group-member');
      let group: GroupView | null = null;
      let member = false;

      try {
        group = await createGroup(adminApi, 'group-rbac', [MANAGE_GROUPS]);
        const session = await login(anonymousApi, fixture.user.username, fixture.password);
        let activeRefreshToken = session.refreshToken;
        let userApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${session.accessToken}` },
        });
        expect((await userApi.get('/api/admin/groups')).status()).toBe(403);

        const added = await expectJson<{ ok: true; taskIds: string[] }>(
          await adminApi.post(`/api/admin/groups/${group.id}/members`, {
            data: { userId: fixture.user.id },
          }),
          201,
        );
        member = true;
        await settleTasks(adminApi, added.taskIds);

        await expectStatus(await userApi.get('/api/auth/me'), 401);
        const grantedSession = await expectJson<RefreshView>(
          await anonymousApi.post('/api/auth/refresh', {
            data: {
              refreshToken: activeRefreshToken,
              requestId: refreshRequestId('membership-capability-granted'),
            },
          }),
        );
        activeRefreshToken = grantedSession.refreshToken;
        userApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${grantedSession.accessToken}` },
        });
        const me = await expectJson<UserView>(await userApi.get('/api/auth/me'));
        expect(me.capabilities).toContain(MANAGE_GROUPS);
        expect(me.capabilities).not.toContain(MANAGE_USERS);
        expect(me.groups).toContainEqual(expect.objectContaining({ id: group.id }));
        expect((await userApi.get('/api/admin/users')).status()).toBe(403);

        const groupList = await expectJson<GroupView[]>(await userApi.get('/api/admin/groups'));
        expect(groupList).toContainEqual(expect.objectContaining({ id: group.id }));
        const fetched = await expectJson<GroupView>(
          await userApi.get(`/api/admin/groups/${group.id}`),
        );
        expect(fetched.capabilities).toEqual([MANAGE_GROUPS]);
        const updated = await expectJson<GroupView>(
          await adminApi.patch(`/api/admin/groups/${group.id}`, {
            data: {
              expectedRevision: fetched.revision,
              description: `${group.name} patched through the real edge`,
              priority: 71,
            },
          }),
        );
        expect(updated.priority).toBe(71);
        const members = await expectJson<Array<{ userId: string; username: string }>>(
          await adminApi.get(`/api/admin/groups/${group.id}/members`),
        );
        expect(members).toContainEqual(
          expect.objectContaining({
            userId: fixture.user.id,
            username: fixture.user.username,
          }),
        );

        await removeGroupMember(adminApi, group.id, fixture.user.id);
        member = false;
        await expectStatus(await userApi.get('/api/auth/me'), 401);
        const revokedSession = await expectJson<RefreshView>(
          await anonymousApi.post('/api/auth/refresh', {
            data: {
              refreshToken: activeRefreshToken,
              requestId: refreshRequestId('membership-capability-revoked'),
            },
          }),
        );
        userApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${revokedSession.accessToken}` },
        });
        expect((await userApi.get('/api/admin/groups')).status()).toBe(403);
        const revoked = await expectJson<UserView>(await userApi.get('/api/auth/me'));
        expect(revoked.capabilities).not.toContain(MANAGE_GROUPS);
        expect(revoked.groups).not.toContainEqual(expect.objectContaining({ id: group.id }));
        expect(
          await expectJson<unknown[]>(await adminApi.get(`/api/admin/groups/${group.id}/members`)),
        ).toEqual([]);
      } finally {
        if (member && group) await removeGroupMember(adminApi, group.id, fixture.user.id);
        if (group) await deleteGroup(adminApi, group.id);
        await deleteUser(adminApi, fixture.user.id);
      }
    },
  );

  test(
    'api.auth-rbac.grants.direct-overrides-inherited-and-revokes',
    coverageCase(
      'auth.identity-rbac.direct-and-inherited-capabilities',
      'api.auth-rbac.grants.direct-overrides-inherited-and-revokes',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      const fixture = await createUser(adminApi, 'grant-subject');
      let group: GroupView | null = null;
      const serverId = seedState.servers[0].serverId;
      const imageId = seedState.image.id;
      let member = false;
      let groupServerGrant = false;
      let groupImageGrant = false;
      let directServerGrant = false;

      try {
        group = await createGroup(adminApi, 'grant-group');
        const added = await expectJson<{ ok: true; taskIds: string[] }>(
          await adminApi.post(`/api/admin/groups/${group.id}/members`, {
            data: { userId: fixture.user.id },
          }),
          201,
        );
        member = true;
        await settleTasks(adminApi, added.taskIds);

        const inheritedGrant = await expectJson<
          TaskIdsView & {
            serverId: string;
            cpuMillis: number;
            memBytes: number;
            diskBytes: number;
            gpuMode: string;
          }
        >(
          await adminApi.post(`/api/admin/groups/${group.id}/server-grants/${serverId}`, {
            data: {
              cpuMillis: 700,
              memBytes: 128 * MIB,
              diskBytes: 64 * MIB,
              gpuMode: 'none',
              gpuIndices: [],
            },
          }),
          201,
        );
        groupServerGrant = true;
        await settleTasks(adminApi, inheritedGrant.taskIds);
        expect(inheritedGrant.serverId).toBe(serverId);

        const inheritedImage = await expectJson<{ imageId: string; serverId: string }>(
          await adminApi.post(`/api/admin/groups/${group.id}/image-grants`, {
            data: { imageId, serverId },
          }),
          201,
        );
        groupImageGrant = true;
        expect(inheritedImage).toMatchObject({ imageId, serverId });
        expect(
          await expectJson<Array<{ serverId: string }>>(
            await adminApi.get(`/api/admin/groups/${group.id}/server-grants`),
          ),
        ).toContainEqual(expect.objectContaining({ serverId }));
        expect(
          await expectJson<Array<{ imageId: string; serverId: string }>>(
            await adminApi.get(`/api/admin/groups/${group.id}/image-grants`),
          ),
        ).toContainEqual(expect.objectContaining({ imageId, serverId }));

        const session = await login(anonymousApi, fixture.user.username, fixture.password);
        const userApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${session.accessToken}` },
        });
        expect(
          (await userApi.get(`/api/admin/users/${fixture.user.id}/server-grants`)).status(),
        ).toBe(403);

        const inherited = await expectJson<EffectiveAccessView>(
          await userApi.get('/api/me/access'),
        );
        expect(inherited.servers).toContainEqual(
          expect.objectContaining({
            serverId,
            cpuMillis: 700,
            memBytes: 128 * MIB,
            diskBytes: 64 * MIB,
            gpuMode: 'none',
            gpuIndices: [],
            allowedImageIds: expect.arrayContaining([imageId]),
          }),
        );

        const directGrant = await expectJson<TaskIdsView>(
          await adminApi.post(`/api/admin/users/${fixture.user.id}/server-grants/${serverId}`, {
            data: {
              cpuMillis: 900,
              memBytes: 192 * MIB,
              diskBytes: 96 * MIB,
              gpuMode: 'none',
              gpuIndices: [],
            },
          }),
          201,
        );
        directServerGrant = true;
        await settleTasks(adminApi, directGrant.taskIds);
        expect(
          await expectJson<Array<{ serverId: string }>>(
            await adminApi.get(`/api/admin/users/${fixture.user.id}/server-grants`),
          ),
        ).toContainEqual(expect.objectContaining({ serverId }));
        const direct = await expectJson<EffectiveAccessView>(
          await adminApi.get(`/api/admin/users/${fixture.user.id}/effective-access`),
        );
        expect(direct.servers).toContainEqual(
          expect.objectContaining({
            serverId,
            cpuMillis: 900,
            memBytes: 192 * MIB,
            diskBytes: 96 * MIB,
            allowedImageIds: expect.arrayContaining([imageId]),
          }),
        );
        expect(
          (await expectJson<EffectiveAccessView>(await userApi.get('/api/me/access'))).servers,
        ).toContainEqual(
          expect.objectContaining({
            serverId,
            cpuMillis: 900,
            memBytes: 192 * MIB,
            diskBytes: 96 * MIB,
            allowedImageIds: expect.arrayContaining([imageId]),
          }),
        );

        const directDeleted = await expectJson<TaskIdsView>(
          await adminApi.delete(`/api/admin/users/${fixture.user.id}/server-grants/${serverId}`),
        );
        directServerGrant = false;
        await settleTasks(adminApi, directDeleted.taskIds);
        const fallback = await expectJson<EffectiveAccessView>(await userApi.get('/api/me/access'));
        expect(fallback.servers).toContainEqual(
          expect.objectContaining({
            serverId,
            cpuMillis: 700,
            diskBytes: 64 * MIB,
          }),
        );

        await expectSuccess(
          await adminApi.delete(
            `/api/admin/groups/${group.id}/image-grants/${imageId}/${serverId}`,
          ),
        );
        groupImageGrant = false;
        const inheritedDeleted = await expectJson<TaskIdsView>(
          await adminApi.delete(`/api/admin/groups/${group.id}/server-grants/${serverId}`),
        );
        groupServerGrant = false;
        await settleTasks(adminApi, inheritedDeleted.taskIds);
        expect(
          (await expectJson<EffectiveAccessView>(await userApi.get('/api/me/access'))).servers,
        ).toEqual([]);
      } finally {
        if (directServerGrant) {
          const response = await adminApi.delete(
            `/api/admin/users/${fixture.user.id}/server-grants/${serverId}`,
          );
          if (response.status() !== 404) {
            await settleTasks(adminApi, (await expectJson<TaskIdsView>(response)).taskIds);
          }
        }
        if (groupImageGrant && group) {
          const response = await adminApi.delete(
            `/api/admin/groups/${group.id}/image-grants/${imageId}/${serverId}`,
          );
          expect([204, 404]).toContain(response.status());
        }
        if (groupServerGrant && group) {
          const response = await adminApi.delete(
            `/api/admin/groups/${group.id}/server-grants/${serverId}`,
          );
          if (response.status() !== 404) {
            await settleTasks(adminApi, (await expectJson<TaskIdsView>(response)).taskIds);
          }
        }
        if (member && group) await removeGroupMember(adminApi, group.id, fixture.user.id);
        if (group) await deleteGroup(adminApi, group.id);
        await deleteUser(adminApi, fixture.user.id);
      }
    },
  );

  test(
    'api.auth-rbac.ownership.cross-user-and-token-isolation',
    coverageCase(
      'auth.identity-rbac.ownership-isolation',
      'api.auth-rbac.ownership.cross-user-and-token-isolation',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory }) => {
      const first = await createUser(adminApi, 'owner-a');
      let second: Awaited<ReturnType<typeof createUser>> | null = null;
      let tokenId: string | null = null;

      try {
        second = await createUser(adminApi, 'owner-b');
        const [firstSession, secondSession] = await Promise.all([
          login(anonymousApi, first.user.username, first.password),
          login(anonymousApi, second.user.username, second.password),
        ]);
        const firstApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${firstSession.accessToken}` },
        });
        const secondApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${secondSession.accessToken}` },
        });

        expect(
          (await expectJson<UserView>(await firstApi.get(`/api/users/${first.user.id}`))).id,
        ).toBe(first.user.id);
        expect(
          (await expectJson<UserView>(await secondApi.get(`/api/users/${second.user.id}`))).id,
        ).toBe(second.user.id);
        expect((await firstApi.get(`/api/users/${second.user.id}`)).status()).toBe(403);
        expect(
          (
            await firstApi.patch(`/api/users/${second.user.id}`, {
              data: { displayName: 'forbidden-cross-user-update' },
            })
          ).status(),
        ).toBe(403);
        expect((await firstApi.get(`/api/users/${second.user.id}/ssh-keys`)).status()).toBe(403);
        expect(
          (
            await firstApi.post(`/api/users/${second.user.id}/ssh-keys`, {
              data: { name: 'forbidden-cross-user-key', keyText: VALID_ED25519_KEY },
            })
          ).status(),
        ).toBe(403);

        const createdToken = await expectJson<ApiTokenView>(
          await firstApi.post('/api/auth/tokens', {
            data: { name: `${currentRunId()}-owner-token` },
          }),
          201,
        );
        tokenId = createdToken.token.id;
        expect((await secondApi.delete(`/api/auth/tokens/${createdToken.token.id}`)).status()).toBe(
          404,
        );
        const tokenApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${createdToken.secret}` },
        });
        const tokenMe = await expectJson<UserView>(await tokenApi.get('/api/auth/me'));
        expect(tokenMe.id).toBe(first.user.id);
        await expectSuccess(await firstApi.delete(`/api/auth/tokens/${createdToken.token.id}`));
        tokenId = null;
        expect((await tokenApi.get('/api/auth/me')).status()).toBe(401);
      } finally {
        if (tokenId) {
          const session = await login(anonymousApi, first.user.username, first.password);
          const firstApi = await trackedApiFactory({
            extraHTTPHeaders: { authorization: `Bearer ${session.accessToken}` },
          });
          const response = await firstApi.delete(`/api/auth/tokens/${tokenId}`);
          expect([204, 404]).toContain(response.status());
        }
        if (second) await deleteUser(adminApi, second.user.id);
        await deleteUser(adminApi, first.user.id);
      }
    },
  );

  test(
    'api.auth-rbac.revocation.disabled-user-invalidates-jwt-and-api-token',
    coverageCase(
      'auth.identity-rbac.revocation',
      'api.auth-rbac.revocation.disabled-user-invalidates-jwt-and-api-token',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory }) => {
      const fixture = await createUser(adminApi, 'revoked-user');
      let userApi: APIRequestContext | null = null;
      let token: ApiTokenView | null = null;

      await runWithCleanupPreservingFailure(async () => {
        const session = await login(anonymousApi, fixture.user.username, fixture.password);
        userApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${session.accessToken}` },
        });
        token = await expectJson<ApiTokenView>(
          await userApi.post('/api/auth/tokens', {
            data: { name: `${currentRunId()}-revocation-token` },
          }),
          201,
        );
        const tokenApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${token.secret}` },
        });
        expect((await expectJson<UserView>(await tokenApi.get('/api/auth/me'))).id).toBe(
          fixture.user.id,
        );
        const changed = await expectJson<UserView>(
          await adminApi.patch(`/api/admin/users/${fixture.user.id}`, {
            data: { status: 'disabled' },
          }),
        );
        expect(changed.status).toBe('disabled');
        expect((await userApi.get('/api/auth/me')).status()).toBe(401);
        expect((await tokenApi.get('/api/auth/me')).status()).toBe(401);
        expect(
          (
            await anonymousApi.post('/api/auth/login', {
              data: { username: fixture.user.username, password: fixture.password },
            })
          ).status(),
        ).toBe(401);
        const restored = await expectJson<UserView>(
          await adminApi.patch(`/api/admin/users/${fixture.user.id}`, {
            data: { status: 'active' },
          }),
        );
        expect(restored.status).toBe('active');
        // Restoring the user rotates authVersion again, so this deliberately stale JWT must
        // remain unauthorized; deleting the user below removes the surviving token.
        const tokenCleanup = await userApi.delete(`/api/auth/tokens/${token.token.id}`);
        expect(tokenCleanup.status()).toBe(401);
      }, () => deleteUser(adminApi, fixture.user.id));
    },
  );
});
