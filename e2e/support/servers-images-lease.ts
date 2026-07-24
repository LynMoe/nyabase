import type { APIRequestContext, APIResponse } from '@playwright/test';
import {
  getContainerOrNull,
  requestContainerAction,
  waitForAgentTask,
  waitForContainerAbsent,
  type AgentTaskView,
  type ContainerView,
} from './durable-api.js';
import { aggregateErrorWithDiagnostics } from './error-diagnostics.mjs';
import { expectJson } from './http.js';

export class AbsoluteDeadline {
  readonly expiresAt: number;

  constructor(timeoutMs: number) {
    this.expiresAt = Date.now() + timeoutMs;
  }

  remaining(label: string, capMs = Number.POSITIVE_INFINITY): number {
    const remaining = this.expiresAt - Date.now();
    if (remaining <= 0) throw new Error(`deadline expired while ${label}`);
    return Math.max(1, Math.min(remaining, capMs));
  }
}

export interface CleanupStep {
  label: string;
  run: () => Promise<void>;
}

export async function runCleanupSteps(label: string, steps: readonly CleanupStep[]): Promise<void> {
  const failures: Error[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failures.push(new Error(`${step.label}: ${errorMessage(error)}`, { cause: error }));
    }
  }
  if (failures.length > 0) {
    throw aggregateErrorWithDiagnostics(`${label} cleanup failed`, failures);
  }
}

export async function expectStatus(
  response: APIResponse,
  expected: number | readonly number[],
  label: string,
): Promise<void> {
  const statuses = Array.isArray(expected) ? expected : [expected];
  if (!statuses.includes(response.status())) {
    throw new Error(
      `${label} returned ${response.status()}, expected ${statuses.join(' or ')}; response body withheld`,
    );
  }
}

export interface ImageIdentity {
  id?: string | null;
  name: string;
}

interface ImageLeaseView {
  id: string;
  name: string;
  deleting: boolean;
}

interface ImageTaskRef {
  taskId: string;
}

export async function resolveImageId(
  adminApi: APIRequestContext,
  identity: ImageIdentity,
): Promise<string | null> {
  if (identity.id) {
    const response = await adminApi.get(`/api/admin/images/${identity.id}`);
    if (response.status() === 200) return identity.id;
    if (response.status() !== 404) {
      await expectStatus(response, 200, `image ${identity.id} lookup`);
    }
  }
  const images = await expectJson<ImageLeaseView[]>(await adminApi.get('/api/admin/images'));
  return images.find((image) => image.name === identity.name)?.id ?? null;
}

export async function cleanupImageLease(
  adminApi: APIRequestContext,
  identity: ImageIdentity,
  deadline: AbsoluteDeadline,
): Promise<void> {
  const imageId = await resolveImageId(adminApi, identity);
  if (!imageId) return;

  while (deadline.remaining(`cleaning image ${imageId}`, 500) > 0) {
    const current = await adminApi.get(`/api/admin/images/${imageId}`);
    if (current.status() === 404) return;
    await expectStatus(current, 200, `image ${imageId} cleanup lookup`);

    const tasks = await expectJson<AgentTaskView[]>(
      await adminApi.get(
        `/api/admin/agent-tasks?resourceType=image&resourceId=${encodeURIComponent(imageId)}&limit=100`,
      ),
    );
    const pending = tasks.filter((task) => task.status === 'pending');
    if (pending.length > 0) {
      await Promise.allSettled(
        pending.map((task) =>
          waitForAgentTask(adminApi, task.id, {
            timeoutMs: deadline.remaining(`waiting for image task ${task.id}`, 120_000),
          }),
        ),
      );
      continue;
    }

    const deletion = await adminApi.delete(`/api/admin/images/${imageId}`);
    if (deletion.status() === 404) return;
    if (deletion.status() === 409) {
      await delay(Math.min(250, deadline.remaining(`waiting to retry image ${imageId} cleanup`)));
      continue;
    }
    const result = await expectJson<{ tasks: ImageTaskRef[] }>(deletion, 202);
    await Promise.allSettled(
      result.tasks.map((task) =>
        waitForAgentTask(adminApi, task.taskId, {
          timeoutMs: deadline.remaining(`waiting for image cleanup task ${task.taskId}`, 120_000),
        }),
      ),
    );
  }
}

export interface ContainerIdentity {
  id?: string | null;
  taskId?: string | null;
  name: string;
  ownerId: string;
  serverId: string;
}

export async function resolveContainerId(
  ownerApi: APIRequestContext,
  adminApi: APIRequestContext,
  identity: ContainerIdentity,
  deadline: AbsoluteDeadline,
): Promise<string | null> {
  if (identity.id) return identity.id;

  const lookupExpiresAt = Math.min(deadline.expiresAt, Date.now() + 15_000);
  while (Date.now() < lookupExpiresAt) {
    if (identity.taskId) {
      const taskResponse = await adminApi.get(`/api/admin/agent-tasks/${identity.taskId}`);
      if (taskResponse.status() === 200) {
        return (await expectJson<AgentTaskView>(taskResponse)).resourceId;
      }
      if (taskResponse.status() !== 404) {
        await expectStatus(taskResponse, 200, `container task ${identity.taskId} lookup`);
      }
    }

    const ownerContainers = await expectJson<ContainerView[]>(
      await ownerApi.get(`/api/v2/containers?serverId=${encodeURIComponent(identity.serverId)}`),
    );
    const found = ownerContainers.find(
      (container) => container.ownerId === identity.ownerId && container.name === identity.name,
    );
    if (found) return found.id;
    await delay(Math.min(250, deadline.remaining(`resolving container ${identity.name}`)));
  }
  return null;
}

export async function cleanupOwnedContainer(
  ownerApi: APIRequestContext,
  adminApi: APIRequestContext,
  identity: ContainerIdentity,
  deadline: AbsoluteDeadline,
): Promise<void> {
  const containerId = await resolveContainerId(ownerApi, adminApi, identity, deadline);
  if (!containerId) return;

  while (deadline.remaining(`cleaning container ${containerId}`, 500) > 0) {
    let container = await getContainerOrNull(ownerApi, containerId);
    if (!container) return;

    if (container.activeTask?.status === 'pending') {
      try {
        await waitForAgentTask(adminApi, container.activeTask.id, {
          timeoutMs: deadline.remaining(
            `waiting for active container task ${container.activeTask.id}`,
            120_000,
          ),
        });
      } catch {
        // Failed lifecycle work is terminal; the next view decides whether delete is available.
      }
      continue;
    }

    if (container.actions.delete?.enabled !== true) {
      await delay(Math.min(250, deadline.remaining(`waiting for container ${containerId} delete`)));
      continue;
    }

    const deletion = await requestContainerAction(ownerApi, containerId, 'delete');
    try {
      await waitForAgentTask(adminApi, deletion.taskId, {
        kind: 'container.delete',
        resourceId: containerId,
        timeoutMs: deadline.remaining(`waiting for container ${containerId} deletion`, 120_000),
      });
    } catch {
      container = await getContainerOrNull(ownerApi, containerId);
      if (!container) return;
      continue;
    }
    await waitForContainerAbsent(
      ownerApi,
      containerId,
      deadline.remaining(`waiting for container ${containerId} absence`, 30_000),
    );
    return;
  }
}

export async function resolveServerIdsBySlugs(
  adminApi: APIRequestContext,
  slugs: ReadonlySet<string>,
  deadline?: AbsoluteDeadline,
): Promise<string[]> {
  const servers = await expectJson<Array<{ id: string; slug: string }>>(
    await adminApi.get(
      '/api/admin/servers',
      deadline
        ? { timeout: deadline.remaining('discovering temporary Servers', 30_000) }
        : undefined,
    ),
  );
  return servers.filter((server) => slugs.has(server.slug)).map((server) => server.id);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
