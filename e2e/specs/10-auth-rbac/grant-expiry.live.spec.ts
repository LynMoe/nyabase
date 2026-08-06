import type { APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test, expect } from '../../fixtures/live-stack.js';
import { ContainerDeadline } from '../../support/container-deadline.js';
import {
  ContainerLease,
  settleContainerActionViaLane,
  uniqueContainerLeaseName,
  waitForContainerViaLane,
} from '../../support/container-lease.js';
import {
  cleanupContainerPersona,
  createContainerPersona,
  refreshContainerPersonaSession,
  type ContainerPersona,
} from '../../support/container-persona.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { waitForAgentTask, type ContainerView } from '../../support/durable-api.js';
import { expectJson } from '../../support/http.js';
import { aggregateErrorWithDiagnostics } from '../../support/error-diagnostics.mjs';
import { currentRunId } from '../../support/runtime-env.js';

/** Must stay aligned with GRANT_EXPIRY_GRACE_DAYS in @nyabase/common. */
const GRANT_EXPIRY_GRACE_DAYS = 14;
const MIB = 1024 * 1024;
let resourceSequence = 0;

interface GroupView {
  id: string;
  name: string;
  priority: number;
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
  expiresAt: string | null;
  purgeAt: string | null;
  accessPhase: 'full' | 'grace';
}

interface EffectiveAccessView {
  servers: ServerAccessView[];
}

interface PurgeResourcesView {
  taskIds: string[];
  containerIds: string[];
  dataDirectoryIds: string[];
}

interface ConflictBody {
  code: string;
  message: string;
}

function resourceStem(label: string): string {
  resourceSequence += 1;
  return `${currentRunId()}-${label}-${Date.now().toString(36)}-${resourceSequence}`;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function settleTasks(adminApi: APIRequestContext, taskIds: readonly string[]): Promise<void> {
  for (const taskId of [...new Set(taskIds)]) {
    await waitForAgentTask(adminApi, taskId, { timeoutMs: 120_000 });
  }
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
  priority = 70,
): Promise<GroupView> {
  const name = resourceStem(label);
  return expectJson<GroupView>(
    await adminApi.post('/api/admin/groups', {
      data: {
        name,
        description: `${name} grant-expiry group`,
        priority,
        capabilities: [],
      },
    }),
    201,
  );
}

function e2ePostgresExec(sql: string): void {
  const runId = currentRunId();
  const container = `nyabase-e2e-${runId}-postgres-1`;
  execFileSync(
    'docker',
    ['exec', '-i', container, 'psql', '-U', 'nyabase', '-d', 'nyabase', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8' },
  );
}

function insertRemoteAuthorizationDependency(userId: string, serverId: string, dependencyId: string): void {
  const safeUser = userId.replace(/'/g, "''");
  const safeServer = serverId.replace(/'/g, "''");
  const safeDep = dependencyId.replace(/'/g, "''");
  e2ePostgresExec(`
    INSERT INTO control.authorization_dependencies (
      id, dependency_kind, dependency_id, user_id, server_id,
      source_kind, source_id, source_identity
    ) VALUES (
      '${randomUUID()}'::uuid,
      'data_directory',
      '${safeDep}',
      '${safeUser}'::uuid,
      '${safeServer}',
      'remote',
      'remote-fs-e2e',
      NULL
    );
  `);
}

function deleteAuthorizationDependency(dependencyId: string): void {
  const safeDep = dependencyId.replace(/'/g, "''");
  e2ePostgresExec(`
    DELETE FROM control.authorization_dependencies
    WHERE dependency_id = '${safeDep}';
  `);
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

async function upsertUserServerGrant(
  adminApi: APIRequestContext,
  userId: string,
  serverId: string,
  data: {
    cpuMillis: number;
    memBytes: number;
    diskBytes: number;
    expiresAt?: string | null;
  },
): Promise<TaskIdsView & { expiresAt: string | null }> {
  const grant = await expectJson<TaskIdsView & { expiresAt: string | null }>(
    await adminApi.post(`/api/admin/users/${userId}/server-grants/${serverId}`, {
      data: {
        cpuMillis: data.cpuMillis,
        memBytes: data.memBytes,
        diskBytes: data.diskBytes,
        gpuMode: 'none',
        gpuIndices: [],
        ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
      },
    }),
    201,
  );
  await settleTasks(adminApi, grant.taskIds);
  return grant;
}

async function upsertGroupServerGrant(
  adminApi: APIRequestContext,
  groupId: string,
  serverId: string,
  data: {
    cpuMillis: number;
    memBytes: number;
    diskBytes: number;
    expiresAt?: string | null;
  },
): Promise<TaskIdsView> {
  const grant = await expectJson<TaskIdsView>(
    await adminApi.post(`/api/admin/groups/${groupId}/server-grants/${serverId}`, {
      data: {
        cpuMillis: data.cpuMillis,
        memBytes: data.memBytes,
        diskBytes: data.diskBytes,
        gpuMode: 'none',
        gpuIndices: [],
        ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
      },
    }),
    201,
  );
  await settleTasks(adminApi, grant.taskIds);
  return grant;
}

function accessForServer(
  access: EffectiveAccessView,
  serverId: string,
): ServerAccessView | undefined {
  return access.servers.find((server) => server.serverId === serverId);
}

async function expectAccessPhase(
  api: APIRequestContext,
  serverId: string,
  phase: 'full' | 'grace',
): Promise<ServerAccessView> {
  const access = await expectJson<EffectiveAccessView>(await api.get('/api/me/access'));
  const server = accessForServer(access, serverId);
  expect(server, `expected ${phase} access on ${serverId}`).toBeTruthy();
  expect(server!.accessPhase).toBe(phase);
  return server!;
}

async function expectNoServerAccess(api: APIRequestContext, serverId: string): Promise<void> {
  const access = await expectJson<EffectiveAccessView>(await api.get('/api/me/access'));
  expect(accessForServer(access, serverId)).toBeUndefined();
}

test.describe('10 auth-rbac grant expiry', () => {
  test(
    'api.auth-rbac.grant-expiry.phases-create-start-and-lost',
    coverageCase(
      'auth.identity-rbac.grant-expiry-phases',
      'api.auth-rbac.grant-expiry.phases-create-start-and-lost',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(420_000);
      const serverId = seedState.servers[0].serverId;
      const imageId = seedState.image.id;
      let persona: ContainerPersona | null = null;
      let lease: ContainerLease | null = null;

      try {
        persona = await createContainerPersona({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          label: 'grant-expiry-phases',
          access: {
            serverId,
            imageId,
            cpuMillis: 1000,
            memBytes: 256 * MIB,
            diskBytes: 128 * MIB,
          },
        });

        const full = await expectAccessPhase(persona.api, serverId, 'full');
        expect(full.expiresAt).toBeNull();
        expect(full.purgeAt).toBeNull();

        lease = new ContainerLease({
          ownerApi: persona.api,
          adminApi,
          ownerId: persona.user.id,
          serverId,
          imageId,
          name: uniqueContainerLeaseName('grant-expiry-phases'),
        });
        const created = await lease.createRunning(new ContainerDeadline(180_000, 'create under full'));

        const graceExpiresAt = daysAgoIso(1);
        const graceGrant = await upsertUserServerGrant(adminApi, persona.user.id, serverId, {
          cpuMillis: 1000,
          memBytes: 256 * MIB,
          diskBytes: 128 * MIB,
          expiresAt: graceExpiresAt,
        });
        expect(graceGrant.expiresAt).toBe(graceExpiresAt);

        const grace = await expectAccessPhase(persona.api, serverId, 'grace');
        expect(grace.expiresAt).toBe(graceExpiresAt);
        expect(new Date(grace.purgeAt!).getTime()).toBe(
          new Date(graceExpiresAt).getTime() + GRANT_EXPIRY_GRACE_DAYS * 24 * 60 * 60 * 1000,
        );

        const createDenied = await persona.api.post('/api/v2/containers', {
          data: {
            serverId,
            imageId,
            name: uniqueContainerLeaseName('grant-expiry-create-denied'),
          },
        });
        expect(createDenied.status()).toBe(403);
        const deniedBody = await expectJson<{ message: string | string[] }>(createDenied, 403);
        expect(String(deniedBody.message)).toContain('expiry grace');

        // Wait for the one-shot grace stop before exercising migration start.
        await waitForContainerViaLane(
          lease.adminLane,
          created.view.id,
          'one-shot grace stop before migration start',
          (container: ContainerView) =>
            container.powerIntent === 'stopped' &&
            container.activeTask === null &&
            (container.runtime.status === 'exited' || container.runtime.status === 'dead') &&
            container.actions.start.enabled,
          new ContainerDeadline(180_000, 'wait for grace one-shot stop'),
        );

        persona = await refreshContainerPersonaSession(
          persona,
          anonymousApi,
          trackedApiFactory,
          'grant-expiry-phases-grace-start',
        );
        lease = new ContainerLease({
          ownerApi: persona.api,
          adminApi,
          ownerId: persona.user.id,
          serverId,
          imageId,
          name: lease.input.name,
        });

        await settleContainerActionViaLane(
          lease.ownerLane,
          adminApi,
          created.view.id,
          'start',
          new ContainerDeadline(120_000, 'start allowed in grace'),
        );
        const restarted = await waitForContainerViaLane(
          lease.ownerLane,
          created.view.id,
          'running again in grace',
          (container) =>
            container.powerIntent === 'running' &&
            container.runtime.status === 'running' &&
            container.activeTask === null,
          new ContainerDeadline(90_000, 'observe restart in grace'),
        );
        expect(restarted.powerIntent).toBe('running');

        await upsertUserServerGrant(adminApi, persona.user.id, serverId, {
          cpuMillis: 1000,
          memBytes: 256 * MIB,
          diskBytes: 128 * MIB,
          expiresAt: daysAgoIso(GRANT_EXPIRY_GRACE_DAYS + 2),
        });
        await expectNoServerAccess(persona.api, serverId);

        expect(
          (
            await persona.api.post(`/api/v2/containers/${created.view.id}/actions/stop`)
          ).status(),
        ).toBe(403);
      } finally {
        const errors: unknown[] = [];
        if (persona) {
          try {
            const purge = await expectJson<PurgeResourcesView>(
              await adminApi.post(
                `/api/admin/users/${persona.user.id}/servers/${serverId}/purge-resources`,
              ),
              201,
            );
            await settleTasks(adminApi, purge.taskIds);
            lease?.markDeleted();
          } catch (error) {
            errors.push(error);
          }
          try {
            await cleanupContainerPersona(
              adminApi,
              persona,
              new ContainerDeadline(180_000, 'cleanup phases persona'),
            );
          } catch (error) {
            errors.push(error);
          }
        } else if (lease) {
          try {
            await lease.cleanup(new ContainerDeadline(180_000, 'cleanup phases lease'));
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw aggregateErrorWithDiagnostics('grant-expiry phases cleanup failed', errors);
        }
      }
    },
  );

  test(
    'api.auth-rbac.grant-expiry.direct-expired-falls-back-to-live-group',
    coverageCase(
      'auth.identity-rbac.grant-expiry-phases',
      'api.auth-rbac.grant-expiry.direct-expired-falls-back-to-live-group',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(240_000);
      const serverId = seedState.servers[0].serverId;
      const imageId = seedState.image.id;
      let persona: ContainerPersona | null = null;
      let group: GroupView | null = null;
      let member = false;
      let groupServerGrant = false;
      let groupImageGrant = false;

      try {
        persona = await createContainerPersona({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          label: 'grant-expiry-fallback',
        });
        group = await createGroup(adminApi, 'grant-expiry-fallback');
        const added = await expectJson<TaskIdsView>(
          await adminApi.post(`/api/admin/groups/${group.id}/members`, {
            data: { userId: persona.user.id },
          }),
          201,
        );
        member = true;
        await settleTasks(adminApi, added.taskIds);
        persona = await refreshContainerPersonaSession(
          persona,
          anonymousApi,
          trackedApiFactory,
          'grant-expiry-fallback-member',
        );

        await upsertGroupServerGrant(adminApi, group.id, serverId, {
          cpuMillis: 700,
          memBytes: 128 * MIB,
          diskBytes: 64 * MIB,
          expiresAt: null,
        });
        groupServerGrant = true;
        await expectJson<{ imageId: string }>(
          await adminApi.post(`/api/admin/groups/${group.id}/image-grants`, {
            data: { imageId, serverId },
          }),
          201,
        );
        groupImageGrant = true;

        await upsertUserServerGrant(adminApi, persona.user.id, serverId, {
          cpuMillis: 900,
          memBytes: 192 * MIB,
          diskBytes: 96 * MIB,
          expiresAt: daysAgoIso(1),
        });

        const access = await expectAccessPhase(persona.api, serverId, 'full');
        expect(access).toMatchObject({
          serverId,
          cpuMillis: 700,
          memBytes: 128 * MIB,
          diskBytes: 64 * MIB,
          expiresAt: null,
          purgeAt: null,
          accessPhase: 'full',
        });
      } finally {
        const errors: unknown[] = [];
        if (persona) {
          try {
            const response = await adminApi.delete(
              `/api/admin/users/${persona.user.id}/server-grants/${serverId}`,
            );
            if (response.status() !== 404) {
              await settleTasks(adminApi, (await expectJson<TaskIdsView>(response)).taskIds);
            }
          } catch (error) {
            errors.push(error);
          }
        }
        if (groupImageGrant && group) {
          try {
            const response = await adminApi.delete(
              `/api/admin/groups/${group.id}/image-grants/${imageId}/${serverId}`,
            );
            expect([204, 404]).toContain(response.status());
          } catch (error) {
            errors.push(error);
          }
        }
        if (groupServerGrant && group) {
          try {
            const response = await adminApi.delete(
              `/api/admin/groups/${group.id}/server-grants/${serverId}`,
            );
            if (response.status() !== 404) {
              await settleTasks(adminApi, (await expectJson<TaskIdsView>(response)).taskIds);
            }
          } catch (error) {
            errors.push(error);
          }
        }
        if (member && group && persona) {
          try {
            await removeGroupMember(adminApi, group.id, persona.user.id);
          } catch (error) {
            errors.push(error);
          }
        }
        if (group) {
          try {
            await deleteGroup(adminApi, group.id);
          } catch (error) {
            errors.push(error);
          }
        }
        if (persona) {
          try {
            await cleanupContainerPersona(
              adminApi,
              persona,
              new ContainerDeadline(180_000, 'cleanup fallback persona'),
            );
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw aggregateErrorWithDiagnostics('grant-expiry fallback cleanup failed', errors);
        }
      }
    },
  );

  test(
    'api.auth-rbac.grant-expiry.latest-group-expires-at-wins',
    coverageCase(
      'auth.identity-rbac.grant-expiry-phases',
      'api.auth-rbac.grant-expiry.latest-group-expires-at-wins',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(240_000);
      const serverId = seedState.servers[0].serverId;
      const imageId = seedState.image.id;
      let persona: ContainerPersona | null = null;
      let earlierGroup: GroupView | null = null;
      let laterGroup: GroupView | null = null;
      const memberships: Array<{ groupId: string; userId: string }> = [];
      const groupServerGrants: Array<{ groupId: string }> = [];
      let groupImageGrantId: string | null = null;

      try {
        persona = await createContainerPersona({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          label: 'grant-expiry-latest',
        });
        earlierGroup = await createGroup(adminApi, 'grant-expiry-earlier');
        laterGroup = await createGroup(adminApi, 'grant-expiry-later');

        for (const group of [earlierGroup, laterGroup]) {
          const added = await expectJson<TaskIdsView>(
            await adminApi.post(`/api/admin/groups/${group.id}/members`, {
              data: { userId: persona.user.id },
            }),
            201,
          );
          memberships.push({ groupId: group.id, userId: persona.user.id });
          await settleTasks(adminApi, added.taskIds);
        }
        persona = await refreshContainerPersonaSession(
          persona,
          anonymousApi,
          trackedApiFactory,
          'grant-expiry-latest-members',
        );

        await upsertGroupServerGrant(adminApi, earlierGroup.id, serverId, {
          cpuMillis: 700,
          memBytes: 128 * MIB,
          diskBytes: 64 * MIB,
          expiresAt: daysAgoIso(2),
        });
        groupServerGrants.push({ groupId: earlierGroup.id });

        await upsertGroupServerGrant(adminApi, laterGroup.id, serverId, {
          cpuMillis: 900,
          memBytes: 192 * MIB,
          diskBytes: 96 * MIB,
          expiresAt: daysAgoIso(0.5),
        });
        groupServerGrants.push({ groupId: laterGroup.id });

        await expectJson<{ imageId: string }>(
          await adminApi.post(`/api/admin/groups/${laterGroup.id}/image-grants`, {
            data: { imageId, serverId },
          }),
          201,
        );
        groupImageGrantId = laterGroup.id;

        const access = await expectAccessPhase(persona.api, serverId, 'grace');
        expect(access).toMatchObject({
          serverId,
          cpuMillis: 900,
          memBytes: 192 * MIB,
          diskBytes: 96 * MIB,
          accessPhase: 'grace',
        });
      } finally {
        const errors: unknown[] = [];
        if (groupImageGrantId) {
          try {
            const response = await adminApi.delete(
              `/api/admin/groups/${groupImageGrantId}/image-grants/${imageId}/${serverId}`,
            );
            expect([204, 404]).toContain(response.status());
          } catch (error) {
            errors.push(error);
          }
        }
        for (const grant of groupServerGrants) {
          try {
            const response = await adminApi.delete(
              `/api/admin/groups/${grant.groupId}/server-grants/${serverId}`,
            );
            if (response.status() !== 404) {
              await settleTasks(adminApi, (await expectJson<TaskIdsView>(response)).taskIds);
            }
          } catch (error) {
            errors.push(error);
          }
        }
        for (const membership of memberships) {
          try {
            await removeGroupMember(adminApi, membership.groupId, membership.userId);
          } catch (error) {
            errors.push(error);
          }
        }
        for (const group of [earlierGroup, laterGroup]) {
          if (!group) continue;
          try {
            await deleteGroup(adminApi, group.id);
          } catch (error) {
            errors.push(error);
          }
        }
        if (persona) {
          try {
            await cleanupContainerPersona(
              adminApi,
              persona,
              new ContainerDeadline(180_000, 'cleanup latest persona'),
            );
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw aggregateErrorWithDiagnostics('grant-expiry latest cleanup failed', errors);
        }
      }
    },
  );

  test(
    'api.auth-rbac.grant-expiry.never-expiring-higher-priority-wins',
    coverageCase(
      'auth.identity-rbac.grant-expiry-phases',
      'api.auth-rbac.grant-expiry.never-expiring-higher-priority-wins',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(240_000);
      const serverId = seedState.servers[0].serverId;
      const imageId = seedState.image.id;
      let persona: ContainerPersona | null = null;
      let lowGroup: GroupView | null = null;
      let highGroup: GroupView | null = null;
      const memberships: Array<{ groupId: string; userId: string }> = [];
      const groupServerGrants: Array<{ groupId: string }> = [];
      let groupImageGrantId: string | null = null;

      try {
        persona = await createContainerPersona({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          label: 'grant-expiry-priority',
        });
        lowGroup = await createGroup(adminApi, 'grant-expiry-low-pri', 10);
        highGroup = await createGroup(adminApi, 'grant-expiry-high-pri', 200);

        for (const group of [lowGroup, highGroup]) {
          const added = await expectJson<TaskIdsView>(
            await adminApi.post(`/api/admin/groups/${group.id}/members`, {
              data: { userId: persona.user.id },
            }),
            201,
          );
          memberships.push({ groupId: group.id, userId: persona.user.id });
          await settleTasks(adminApi, added.taskIds);
        }
        persona = await refreshContainerPersonaSession(
          persona,
          anonymousApi,
          trackedApiFactory,
          'grant-expiry-priority-members',
        );

        await upsertGroupServerGrant(adminApi, lowGroup.id, serverId, {
          cpuMillis: 500,
          memBytes: 64 * MIB,
          diskBytes: 32 * MIB,
          expiresAt: null,
        });
        groupServerGrants.push({ groupId: lowGroup.id });
        await upsertGroupServerGrant(adminApi, highGroup.id, serverId, {
          cpuMillis: 1100,
          memBytes: 160 * MIB,
          diskBytes: 80 * MIB,
          expiresAt: null,
        });
        groupServerGrants.push({ groupId: highGroup.id });
        await expectJson<{ imageId: string }>(
          await adminApi.post(`/api/admin/groups/${highGroup.id}/image-grants`, {
            data: { imageId, serverId },
          }),
          201,
        );
        groupImageGrantId = highGroup.id;

        const access = await expectAccessPhase(persona.api, serverId, 'full');
        expect(access).toMatchObject({
          serverId,
          cpuMillis: 1100,
          memBytes: 160 * MIB,
          diskBytes: 80 * MIB,
          accessPhase: 'full',
          expiresAt: null,
          purgeAt: null,
        });
      } finally {
        const errors: unknown[] = [];
        if (groupImageGrantId) {
          try {
            const response = await adminApi.delete(
              `/api/admin/groups/${groupImageGrantId}/image-grants/${imageId}/${serverId}`,
            );
            expect([204, 404]).toContain(response.status());
          } catch (error) {
            errors.push(error);
          }
        }
        for (const entry of groupServerGrants) {
          try {
            const response = await adminApi.delete(
              `/api/admin/groups/${entry.groupId}/server-grants/${serverId}`,
            );
            if (response.status() !== 404) {
              await settleTasks(adminApi, (await expectJson<TaskIdsView>(response)).taskIds);
            }
          } catch (error) {
            errors.push(error);
          }
        }
        for (const membership of memberships) {
          try {
            await removeGroupMember(adminApi, membership.groupId, membership.userId);
          } catch (error) {
            errors.push(error);
          }
        }
        for (const group of [highGroup, lowGroup]) {
          if (!group) continue;
          try {
            await deleteGroup(adminApi, group.id);
          } catch (error) {
            errors.push(error);
          }
        }
        if (persona) {
          try {
            await cleanupContainerPersona(
              adminApi,
              persona,
              new ContainerDeadline(180_000, 'cleanup priority persona'),
            );
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw aggregateErrorWithDiagnostics('grant-expiry priority cleanup failed', errors);
        }
      }
    },
  );

  test(
    'api.auth-rbac.grant-expiry.live-never-beats-finite-expires',
    coverageCase(
      'auth.identity-rbac.grant-expiry-phases',
      'api.auth-rbac.grant-expiry.live-never-beats-finite-expires',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(240_000);
      const serverId = seedState.servers[0].serverId;
      const imageId = seedState.image.id;
      let persona: ContainerPersona | null = null;
      let finiteGroup: GroupView | null = null;
      let neverGroup: GroupView | null = null;
      const memberships: Array<{ groupId: string; userId: string }> = [];
      const groupServerGrants: Array<{ groupId: string }> = [];
      let groupImageGrantId: string | null = null;

      try {
        persona = await createContainerPersona({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          label: 'grant-expiry-never-vs-finite',
        });
        finiteGroup = await createGroup(adminApi, 'grant-expiry-finite', 300);
        neverGroup = await createGroup(adminApi, 'grant-expiry-never', 5);

        for (const group of [finiteGroup, neverGroup]) {
          const added = await expectJson<TaskIdsView>(
            await adminApi.post(`/api/admin/groups/${group.id}/members`, {
              data: { userId: persona.user.id },
            }),
            201,
          );
          memberships.push({ groupId: group.id, userId: persona.user.id });
          await settleTasks(adminApi, added.taskIds);
        }
        persona = await refreshContainerPersonaSession(
          persona,
          anonymousApi,
          trackedApiFactory,
          'grant-expiry-never-vs-finite-members',
        );

        const futureExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        await upsertGroupServerGrant(adminApi, finiteGroup.id, serverId, {
          cpuMillis: 1300,
          memBytes: 200 * MIB,
          diskBytes: 100 * MIB,
          expiresAt: futureExpires,
        });
        groupServerGrants.push({ groupId: finiteGroup.id });
        await upsertGroupServerGrant(adminApi, neverGroup.id, serverId, {
          cpuMillis: 800,
          memBytes: 96 * MIB,
          diskBytes: 48 * MIB,
          expiresAt: null,
        });
        groupServerGrants.push({ groupId: neverGroup.id });
        await expectJson<{ imageId: string }>(
          await adminApi.post(`/api/admin/groups/${neverGroup.id}/image-grants`, {
            data: { imageId, serverId },
          }),
          201,
        );
        groupImageGrantId = neverGroup.id;

        const access = await expectAccessPhase(persona.api, serverId, 'full');
        expect(access).toMatchObject({
          serverId,
          cpuMillis: 800,
          memBytes: 96 * MIB,
          diskBytes: 48 * MIB,
          accessPhase: 'full',
          expiresAt: null,
          purgeAt: null,
        });
      } finally {
        const errors: unknown[] = [];
        if (groupImageGrantId) {
          try {
            const response = await adminApi.delete(
              `/api/admin/groups/${groupImageGrantId}/image-grants/${imageId}/${serverId}`,
            );
            expect([204, 404]).toContain(response.status());
          } catch (error) {
            errors.push(error);
          }
        }
        for (const entry of groupServerGrants) {
          try {
            const response = await adminApi.delete(
              `/api/admin/groups/${entry.groupId}/server-grants/${serverId}`,
            );
            if (response.status() !== 404) {
              await settleTasks(adminApi, (await expectJson<TaskIdsView>(response)).taskIds);
            }
          } catch (error) {
            errors.push(error);
          }
        }
        for (const membership of memberships) {
          try {
            await removeGroupMember(adminApi, membership.groupId, membership.userId);
          } catch (error) {
            errors.push(error);
          }
        }
        for (const group of [neverGroup, finiteGroup]) {
          if (!group) continue;
          try {
            await deleteGroup(adminApi, group.id);
          } catch (error) {
            errors.push(error);
          }
        }
        if (persona) {
          try {
            await cleanupContainerPersona(
              adminApi,
              persona,
              new ContainerDeadline(180_000, 'cleanup never-vs-finite persona'),
            );
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw aggregateErrorWithDiagnostics('grant-expiry never-vs-finite cleanup failed', errors);
        }
      }
    },
  );

  test(
    'api.auth-rbac.grant-expiry.remote-dependency-does-not-block-revoke',
    coverageCase(
      'auth.identity-rbac.grant-expiry-purge',
      'api.auth-rbac.grant-expiry.remote-dependency-does-not-block-revoke',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(240_000);
      const serverId = seedState.servers[0].serverId;
      const imageId = seedState.image.id;
      let persona: ContainerPersona | null = null;
      const remoteDependencyId = `remote-only-${resourceStem('dep')}`;
      let inserted = false;

      await runWithCleanupPreservingFailure(
        async () => {
          persona = await createContainerPersona({
            adminApi,
            anonymousApi,
            trackedApiFactory,
            label: 'grant-expiry-remote-revoke',
            access: {
              serverId,
              imageId,
              cpuMillis: 1000,
              memBytes: 256 * MIB,
              diskBytes: 128 * MIB,
            },
          });

          insertRemoteAuthorizationDependency(persona.user.id, serverId, remoteDependencyId);
          inserted = true;

          const revoked = await expectJson<TaskIdsView>(
            await adminApi.delete(`/api/admin/users/${persona.user.id}/server-grants/${serverId}`),
          );
          await settleTasks(adminApi, revoked.taskIds);
          await expectNoServerAccess(persona.api, serverId);
        },
        async () => {
          const errors: unknown[] = [];
          if (inserted) {
            try {
              deleteAuthorizationDependency(remoteDependencyId);
            } catch (error) {
              errors.push(error);
            }
          }
          if (persona) {
            try {
              await cleanupContainerPersona(
                adminApi,
                persona,
                new ContainerDeadline(180_000, 'cleanup remote-revoke persona'),
              );
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0) {
            throw aggregateErrorWithDiagnostics('grant-expiry remote-revoke cleanup failed', errors);
          }
        },
      );
    },
  );

  test(
    'api.auth-rbac.grant-expiry.purge-then-revoke',
    coverageCase(
      'auth.identity-rbac.grant-expiry-purge',
      'api.auth-rbac.grant-expiry.purge-then-revoke',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(420_000);
      const serverId = seedState.servers[0].serverId;
      const imageId = seedState.image.id;
      const mount = seedState.mountSourceGrants.find((grant) => grant.serverId === serverId);
      expect(mount, `seed mount source for ${serverId}`).toBeTruthy();
      let persona: ContainerPersona | null = null;
      let lease: ContainerLease | null = null;
      let purged = false;
      let dataDirName: string | null = null;
      let mountGranted = false;

      await runWithCleanupPreservingFailure(
        async () => {
          persona = await createContainerPersona({
            adminApi,
            anonymousApi,
            trackedApiFactory,
            label: 'grant-expiry-purge',
            access: {
              serverId,
              imageId,
              cpuMillis: 1000,
              memBytes: 256 * MIB,
              diskBytes: 128 * MIB,
            },
          });

          await expectJson<{ taskIds?: string[] } | Record<string, unknown>>(
            await adminApi.post(`/api/admin/mount-sources/grants/local/${mount!.diskId}`, {
              data: {
                scope: 'user',
                scopeId: persona.user.id,
                serverId,
              },
            }),
            201,
          );
          mountGranted = true;

          dataDirName = resourceStem('localdir').slice(0, 40);
          const createdDir = await expectJson<{ id: string; taskId: string | null }>(
            await adminApi.post('/api/admin/data-dirs', {
              data: {
                userId: persona.user.id,
                serverId,
                sourceKind: 'local',
                sourceId: mount!.diskId,
                name: dataDirName,
              },
            }),
            201,
          );
          if (createdDir.taskId) {
            await waitForAgentTask(adminApi, createdDir.taskId, {
              kind: 'datadir.ensure',
              resourceId: createdDir.id,
              timeoutMs: 120_000,
            });
          }

          lease = new ContainerLease({
            ownerApi: persona.api,
            adminApi,
            ownerId: persona.user.id,
            serverId,
            imageId,
            name: uniqueContainerLeaseName('grant-expiry-purge'),
          });
          const created = await lease.createRunning(
            new ContainerDeadline(180_000, 'create for purge'),
          );

          const revokeBlocked = await adminApi.delete(
            `/api/admin/users/${persona.user.id}/server-grants/${serverId}`,
          );
          expect(revokeBlocked.status()).toBe(409);
          const conflict = await expectJson<ConflictBody>(revokeBlocked, 409);
          expect(conflict.code).toBe('ACCESS_REVOKE_HAS_RESOURCES');

          const purge = await expectJson<PurgeResourcesView>(
            await adminApi.post(
              `/api/admin/users/${persona.user.id}/servers/${serverId}/purge-resources`,
            ),
            201,
          );
          purged = true;
          expect(purge.containerIds).toContain(created.view.id);
          expect(purge.dataDirectoryIds.length).toBeGreaterThan(0);
          await settleTasks(adminApi, purge.taskIds);
          lease.markDeleted();

          const revoked = await expectJson<TaskIdsView>(
            await adminApi.delete(`/api/admin/users/${persona.user.id}/server-grants/${serverId}`),
          );
          await settleTasks(adminApi, revoked.taskIds);
          await expectNoServerAccess(persona.api, serverId);
        },
        async () => {
          const errors: unknown[] = [];
          if (lease && !purged) {
            try {
              await lease.cleanup(new ContainerDeadline(180_000, 'cleanup purge lease'));
            } catch (error) {
              errors.push(error);
            }
          }
          if (persona) {
            if (!purged) {
              try {
                await adminApi.post(
                  `/api/admin/users/${persona.user.id}/servers/${serverId}/purge-resources`,
                );
              } catch (error) {
                errors.push(error);
              }
            }
            if (mountGranted && dataDirName && mount) {
              try {
                await adminApi.delete(
                  `/api/admin/data-dirs/${serverId}/${mount.diskId}/${dataDirName}` +
                    `?sourceKind=local&userId=${encodeURIComponent(persona.user.id)}`,
                );
              } catch (error) {
                errors.push(error);
              }
            }
            if (mountGranted && mount) {
              try {
                await adminApi.delete(
                  `/api/admin/mount-sources/grants/local/${mount.diskId}/user/${persona.user.id}` +
                    `?serverId=${encodeURIComponent(serverId)}`,
                );
              } catch (error) {
                errors.push(error);
              }
            }
            try {
              await cleanupContainerPersona(
                adminApi,
                persona,
                new ContainerDeadline(180_000, 'cleanup purge persona'),
              );
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0) {
            throw aggregateErrorWithDiagnostics('grant-expiry purge cleanup failed', errors);
          }
        },
      );
    },
  );

  test(
    'api.auth-rbac.grant-expiry.worker-stops-grace-and-purges-lost',
    coverageCase(
      'auth.identity-rbac.grant-expiry-purge',
      'api.auth-rbac.grant-expiry.worker-stops-grace-and-purges-lost',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(600_000);
      const serverId = seedState.servers[0].serverId;
      const imageId = seedState.image.id;
      let persona: ContainerPersona | null = null;
      let lease: ContainerLease | null = null;

      await runWithCleanupPreservingFailure(
        async () => {
          persona = await createContainerPersona({
            adminApi,
            anonymousApi,
            trackedApiFactory,
            label: 'grant-expiry-worker',
            access: {
              serverId,
              imageId,
              cpuMillis: 1000,
              memBytes: 256 * MIB,
              diskBytes: 128 * MIB,
            },
          });
          lease = new ContainerLease({
            ownerApi: persona.api,
            adminApi,
            ownerId: persona.user.id,
            serverId,
            imageId,
            name: uniqueContainerLeaseName('grant-expiry-worker'),
          });
          const created = await lease.createRunning(
            new ContainerDeadline(180_000, 'create for expiry worker'),
          );

          await upsertUserServerGrant(adminApi, persona.user.id, serverId, {
            cpuMillis: 1000,
            memBytes: 256 * MIB,
            diskBytes: 128 * MIB,
            expiresAt: daysAgoIso(1),
          });
          await expectAccessPhase(persona.api, serverId, 'grace');

          const stopped = await waitForContainerViaLane(
            lease.adminLane,
            created.view.id,
            'worker one-shot auto-stop in grace',
            (container: ContainerView) =>
              container.powerIntent === 'stopped' &&
              container.activeTask === null &&
              (container.runtime.status === 'exited' || container.runtime.status === 'dead') &&
              container.actions.start.enabled,
            new ContainerDeadline(180_000, 'wait for grace one-shot stop'),
          );
          expect(stopped.powerIntent).toBe('stopped');

          persona = await refreshContainerPersonaSession(
            persona,
            anonymousApi,
            trackedApiFactory,
            'grant-expiry-worker-grace-start',
          );
          lease = new ContainerLease({
            ownerApi: persona.api,
            adminApi,
            ownerId: persona.user.id,
            serverId,
            imageId,
            name: lease.input.name,
          });

          await settleContainerActionViaLane(
            lease.ownerLane,
            adminApi,
            created.view.id,
            'start',
            new ContainerDeadline(120_000, 'restart for migration in grace'),
          );
          const migrated = await waitForContainerViaLane(
            lease.ownerLane,
            created.view.id,
            'running after grace migration start',
            (container: ContainerView) =>
              container.powerIntent === 'running' &&
              container.runtime.status === 'running' &&
              container.activeTask === null,
            new ContainerDeadline(90_000, 'observe migration start'),
          );
          expect(migrated.powerIntent).toBe('running');

          // Worker interval is 60s; wait more than one pass to prove it does not re-stop.
          const holdDeadline = new ContainerDeadline(90_000, 'hold through worker pass');
          await holdDeadline.delay('wait for another worker interval', 70_000);
          const stillRunning = await waitForContainerViaLane(
            lease.ownerLane,
            created.view.id,
            'still running after worker pass',
            (container: ContainerView) =>
              container.powerIntent === 'running' &&
              container.runtime.status === 'running' &&
              container.activeTask === null,
            new ContainerDeadline(30_000, 'confirm no re-stop'),
          );
          expect(stillRunning.powerIntent).toBe('running');

          await upsertUserServerGrant(adminApi, persona.user.id, serverId, {
            cpuMillis: 1000,
            memBytes: 256 * MIB,
            diskBytes: 128 * MIB,
            expiresAt: daysAgoIso(GRANT_EXPIRY_GRACE_DAYS + 2),
          });
          await expectNoServerAccess(persona.api, serverId);

          const absentDeadline = new ContainerDeadline(180_000, 'wait for lost auto-purge');
          while (true) {
            absentDeadline.remaining('poll lost purge');
            const response = await adminApi.get(`/api/admin/v2/containers/${created.view.id}`, {
              timeout: absentDeadline.remaining('get container during lost purge', 30_000),
            });
            if (response.status() === 404) {
              lease.markDeleted();
              break;
            }
            expect(response.status()).toBe(200);
            await absentDeadline.delay('poll lost purge', 2_000);
          }
        },
        async () => {
          const errors: unknown[] = [];
          if (lease) {
            try {
              await lease.cleanup(new ContainerDeadline(180_000, 'cleanup worker lease'));
            } catch (error) {
              errors.push(error);
            }
          }
          if (persona) {
            try {
              await adminApi.post(
                `/api/admin/users/${persona.user.id}/servers/${serverId}/purge-resources`,
              );
            } catch (error) {
              errors.push(error);
            }
            try {
              await cleanupContainerPersona(
                adminApi,
                persona,
                new ContainerDeadline(180_000, 'cleanup worker persona'),
              );
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0) {
            throw aggregateErrorWithDiagnostics('grant-expiry worker cleanup failed', errors);
          }
        },
      );
    },
  );
});
