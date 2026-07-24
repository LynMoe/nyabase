import type { APIRequestContext, APIResponse } from '@playwright/test';
import { ContainerDeadline } from './container-deadline.js';
import { waitForAgentTask } from './durable-api.js';
import { aggregateErrorWithDiagnostics } from './error-diagnostics.mjs';
import { expectJson } from './http.js';
import { currentRunId } from './runtime-env.js';

export type TrackedApiFactory = (options?: {
  extraHTTPHeaders?: Record<string, string>;
}) => Promise<APIRequestContext>;

export interface ContainerPersonaUser {
  id: string;
  username: string;
  displayName: string;
  status: 'active' | 'disabled' | 'deleting' | 'deleted';
  capabilities: string[];
}

interface ContainerPersonaSession {
  accessToken: string;
  refreshToken: string;
  user: ContainerPersonaUser;
}

export interface ContainerPersona {
  user: ContainerPersonaUser;
  password: string;
  accessToken: string;
  api: APIRequestContext;
  access: {
    serverId: string;
    imageId: string;
  } | null;
}

export interface CreateContainerPersonaInput {
  adminApi: APIRequestContext;
  anonymousApi: APIRequestContext;
  trackedApiFactory: TrackedApiFactory;
  label: string;
  access?: {
    serverId: string;
    imageId: string;
    cpuMillis?: number;
    memBytes?: number;
    diskBytes?: number;
  };
}

let personaSequence = 0;

export async function createContainerPersona(
  input: CreateContainerPersonaInput,
): Promise<ContainerPersona> {
  const stem = personaStem(input.label);
  const password = `E2e-${stem.slice(-20)}-Cpu!`;
  const user = await expectJson<ContainerPersonaUser>(
    await input.adminApi.post('/api/admin/users', {
      data: {
        username: stem.replace(/-/g, '_').slice(0, 64),
        password,
        displayName: `${stem} container persona`,
      },
    }),
    201,
  );

  try {
    if (user.status !== 'active' || user.capabilities.length !== 0) {
      throw new Error(
        `Temporary container persona ${user.id} is not an ordinary active user: ${JSON.stringify({
          status: user.status,
          capabilities: user.capabilities,
        })}`,
      );
    }

    if (input.access) {
      const grant = await expectJson<{ taskIds: string[] }>(
        await input.adminApi.post(
          `/api/admin/users/${user.id}/server-grants/${input.access.serverId}`,
          {
            data: {
              cpuMillis: input.access.cpuMillis ?? 2000,
              memBytes: input.access.memBytes ?? 1_073_741_824,
              diskBytes: input.access.diskBytes ?? 2_147_483_648,
              gpuMode: 'none',
              gpuIndices: [],
            },
          },
        ),
        201,
      );
      const grantDeadline = new ContainerDeadline(180_000, `grant access to ${user.id}`);
      for (const taskId of [...new Set(grant.taskIds)]) {
        await waitForAgentTask(input.adminApi, taskId, {
          kind: 'quota.ensure',
          resourceId: user.id,
          timeoutMs: grantDeadline.remaining(`quota task ${taskId}`),
        });
      }
      await expectJson<unknown>(
        await input.adminApi.post(`/api/admin/users/${user.id}/image-grants`, {
          data: {
            imageId: input.access.imageId,
            serverId: input.access.serverId,
          },
        }),
        201,
      );
    }

    const session = await expectJson<ContainerPersonaSession>(
      await input.anonymousApi.post('/api/auth/login', {
        data: { username: user.username, password },
      }),
    );
    if (session.user.id !== user.id || session.user.capabilities.length !== 0) {
      throw new Error(`Container persona login returned an unexpected identity for ${user.id}`);
    }
    const api = await input.trackedApiFactory({
      extraHTTPHeaders: { authorization: `Bearer ${session.accessToken}` },
    });
    const me = await expectJson<ContainerPersonaUser>(await api.get('/api/auth/me'));
    if (me.id !== user.id || me.capabilities.length !== 0) {
      throw new Error(`Container persona API is not bound to ordinary user ${user.id}`);
    }

    return {
      user,
      password,
      accessToken: session.accessToken,
      api,
      access: input.access
        ? { serverId: input.access.serverId, imageId: input.access.imageId }
        : null,
    };
  } catch (error) {
    const partial: ContainerPersona = {
      user,
      password,
      accessToken: '',
      api: input.adminApi,
      access: input.access
        ? { serverId: input.access.serverId, imageId: input.access.imageId }
        : null,
    };
    try {
      await cleanupContainerPersona(
        input.adminApi,
        partial,
        new ContainerDeadline(180_000, `failed persona setup cleanup ${user.id}`),
      );
    } catch (cleanupError) {
      throw aggregateErrorWithDiagnostics(
        `Container persona ${user.id} setup and cleanup both failed`,
        [error, cleanupError],
      );
    }
    throw error;
  }
}

export async function cleanupContainerPersona(
  adminApi: APIRequestContext,
  persona: Pick<ContainerPersona, 'user' | 'access'>,
  deadline = new ContainerDeadline(180_000, `container persona cleanup ${persona.user.id}`),
): Promise<void> {
  const errors: unknown[] = [];
  if (persona.access) {
    await attemptCleanup(errors, async () => {
      const response = await adminApi.delete(
        `/api/admin/users/${persona.user.id}/image-grants/${persona.access!.imageId}/${persona.access!.serverId}`,
        {
          timeout: deadline.remaining(`delete image grant for ${persona.user.id}`, 30_000),
        },
      );
      await expectOneOf(response, [204, 404], 'delete temporary container image grant');
    });
    await attemptCleanup(errors, async () => {
      const response = await adminApi.delete(
        `/api/admin/users/${persona.user.id}/server-grants/${persona.access!.serverId}`,
        {
          timeout: deadline.remaining(`delete server grant for ${persona.user.id}`, 30_000),
        },
      );
      if (response.status() === 404) return;
      const result = await expectJson<{ taskIds: string[] }>(response);
      for (const taskId of [...new Set(result.taskIds)]) {
        await waitForAgentTask(adminApi, taskId, {
          timeoutMs: deadline.remaining(`settle server grant cleanup task ${taskId}`),
        });
      }
    });
  }
  await attemptCleanup(errors, async () => {
    await deleteTemporaryUser(adminApi, persona.user.id, deadline);
  });
  throwCleanupErrors(`Container persona ${persona.user.id} cleanup`, errors);
}

async function deleteTemporaryUser(
  adminApi: APIRequestContext,
  userId: string,
  deadline: ContainerDeadline,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await adminApi.get(`/api/admin/users/${userId}`, {
      timeout: deadline.remaining(`look up temporary user ${userId}`, 30_000),
    });
    if (existing.status() === 404) return;
    await expectOneOf(existing, [200], 'look up temporary container user');

    const result = await expectJson<{ deleted: boolean; taskIds: string[] }>(
      await adminApi.delete(`/api/admin/users/${userId}`, {
        timeout: deadline.remaining(`delete temporary user ${userId}`, 30_000),
      }),
    );
    for (const taskId of [...new Set(result.taskIds)]) {
      await waitForAgentTask(adminApi, taskId, {
        timeoutMs: deadline.remaining(`settle temporary user cleanup task ${taskId}`),
      });
    }
    if (result.deleted) return;
  }
  const remaining = await adminApi.get(`/api/admin/users/${userId}`, {
    timeout: deadline.remaining(`confirm temporary user ${userId} deletion`, 30_000),
  });
  await expectOneOf(remaining, [404], 'confirm temporary container user deletion');
}

async function expectOneOf(
  response: APIResponse,
  statuses: readonly number[],
  description: string,
): Promise<void> {
  if (statuses.includes(response.status())) return;
  const body = await response.text();
  throw new Error(
    `${description} returned ${response.status()}, expected ${statuses.join(' or ')}: ${body}`,
  );
}

async function attemptCleanup(errors: unknown[], step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    errors.push(error);
  }
}

function throwCleanupErrors(description: string, errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw aggregateErrorWithDiagnostics(
      `${description} had ${errors.length} failures`,
      errors,
    );
  }
}

function personaStem(label: string): string {
  personaSequence += 1;
  const runId = currentRunId()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 28);
  const safeLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 18);
  return `${runId}-${safeLabel}-${Date.now().toString(36)}-${personaSequence}`.slice(0, 64);
}
