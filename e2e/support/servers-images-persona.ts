import type { APIRequestContext } from '@playwright/test';
import { waitForAgentTask } from './durable-api.js';
import { aggregateErrorWithDiagnostics } from './error-diagnostics.mjs';
import { expectJson } from './http.js';
import { AbsoluteDeadline, expectStatus, runCleanupSteps } from './servers-images-lease.js';

const setupFailureCleanupBudgetMs = 120_000;

export type TrackedApiFactory = (options?: {
  extraHTTPHeaders?: Record<string, string>;
}) => Promise<APIRequestContext>;

interface UserView {
  id: string;
  username: string;
}

interface LoginView {
  accessToken: string;
}

interface TaskIdsView {
  taskIds: string[];
}

interface PersonaOptions {
  adminApi: APIRequestContext;
  anonymousApi: APIRequestContext;
  trackedApiFactory: TrackedApiFactory;
  runId: string;
  label: string;
  deadline: AbsoluteDeadline;
  serverId?: string;
  imageId?: string;
}

let personaSequence = 0;

export class StandardPersonaLease {
  readonly username: string;
  readonly password: string;
  readonly adminApi: APIRequestContext;
  readonly deadline: AbsoluteDeadline;
  private readonly serverGrants = new Set<string>();
  private readonly imageGrants = new Map<string, { imageId: string; serverId: string }>();
  private userIdValue: string | null = null;
  private apiValue: APIRequestContext | null = null;

  constructor(options: PersonaOptions) {
    const nonce = `${Date.now().toString(36)}_${personaSequence++}`;
    const label = options.label.replace(/[^a-zA-Z0-9_]/g, '_');
    const suffix = `${label.slice(0, Math.max(1, 32 - nonce.length - 1))}_${nonce}`;
    const runPrefix = options.runId.replace(/[^a-zA-Z0-9_]/g, '_');
    this.username = `${runPrefix.slice(0, Math.max(1, 64 - suffix.length - 1))}_${suffix}`;
    this.password = `E2e-${nonce}-${options.runId.slice(-8)}-Cpu!`;
    this.adminApi = options.adminApi;
    this.deadline = options.deadline;
  }

  get userId(): string {
    if (!this.userIdValue) throw new Error(`persona ${this.username} has no resolved user id`);
    return this.userIdValue;
  }

  get api(): APIRequestContext {
    if (!this.apiValue) throw new Error(`persona ${this.username} has no authenticated API`);
    return this.apiValue;
  }

  async initialize(options: PersonaOptions): Promise<void> {
    const created = await expectJson<UserView>(
      await options.adminApi.post('/api/admin/users', {
        data: {
          username: this.username,
          password: this.password,
          displayName: `${options.runId} ${options.label}`,
        },
      }),
      201,
    );
    this.userIdValue = created.id;
    const session = await expectJson<LoginView>(
      await options.anonymousApi.post('/api/auth/login', {
        data: { username: this.username, password: this.password },
      }),
    );
    this.apiValue = await options.trackedApiFactory({
      extraHTTPHeaders: { authorization: `Bearer ${session.accessToken}` },
    });

    if (options.serverId) await this.grantServer(options.serverId);
    if (options.imageId) {
      if (!options.serverId) throw new Error('an image grant requires a server grant target');
      await this.grantImage(options.imageId, options.serverId);
    }
  }

  async grantServer(serverId: string): Promise<void> {
    this.serverGrants.add(serverId);
    const granted = await expectJson<TaskIdsView>(
      await this.adminApi.post(`/api/admin/users/${this.userId}/server-grants/${serverId}`, {
        data: {
          cpuMillis: 500,
          memBytes: 256 * 1024 * 1024,
          diskBytes: 512 * 1024 * 1024,
          gpuMode: 'none',
          gpuIndices: [],
        },
      }),
      201,
    );
    await this.settleTaskIds(granted.taskIds, 'server grant');
  }

  async grantImage(imageId: string, serverId: string): Promise<void> {
    const key = imageGrantKey(imageId, serverId);
    this.imageGrants.set(key, { imageId, serverId });
    await expectJson(
      await this.adminApi.post(`/api/admin/users/${this.userId}/image-grants`, {
        data: { imageId, serverId },
      }),
      201,
    );
  }

  async revokeImage(imageId: string, serverId: string, deadline?: AbsoluteDeadline): Promise<void> {
    if (!this.userIdValue) return;
    const response = await this.adminApi.delete(
      `/api/admin/users/${this.userIdValue}/image-grants/${imageId}/${serverId}`,
      deadline
        ? { timeout: deadline.remaining(`revoking image grant ${imageId}/${serverId}`, 30_000) }
        : undefined,
    );
    await expectStatus(response, [204, 404], `revoking image grant ${imageId}/${serverId}`);
    this.imageGrants.delete(imageGrantKey(imageId, serverId));
  }

  async cleanup(deadline: AbsoluteDeadline = this.deadline): Promise<void> {
    await this.resolveUserId();
    if (!this.userIdValue) return;
    const imageGrants = [...this.imageGrants.values()];
    const serverGrants = [...this.serverGrants];
    await runCleanupSteps(`persona ${this.username}`, [
      ...imageGrants.map((grant) => ({
        label: `revoke image ${grant.imageId}/${grant.serverId}`,
        run: () => this.revokeImage(grant.imageId, grant.serverId, deadline),
      })),
      ...serverGrants.map((serverId) => ({
        label: `revoke server ${serverId}`,
        run: () => this.revokeServer(serverId, deadline),
      })),
      { label: 'delete user', run: () => this.deleteUser(deadline) },
    ]);
  }

  private async revokeServer(serverId: string, deadline: AbsoluteDeadline): Promise<void> {
    if (!this.userIdValue) return;
    const response = await this.adminApi.delete(
      `/api/admin/users/${this.userIdValue}/server-grants/${serverId}`,
    );
    if (response.status() === 404) {
      this.serverGrants.delete(serverId);
      return;
    }
    const removed = await expectJson<TaskIdsView>(response);
    await this.settleTaskIds(removed.taskIds, 'server grant revocation', deadline);
    this.serverGrants.delete(serverId);
  }

  private async deleteUser(deadline: AbsoluteDeadline): Promise<void> {
    if (!this.userIdValue) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const exists = await this.adminApi.get(`/api/admin/users/${this.userIdValue}`);
      if (exists.status() === 404) {
        this.userIdValue = null;
        return;
      }
      await expectStatus(exists, 200, `persona ${this.username} lookup`);
      const deleted = await expectJson<{ deleted: boolean; taskIds: string[] }>(
        await this.adminApi.delete(`/api/admin/users/${this.userIdValue}`),
      );
      await this.settleTaskIds(deleted.taskIds, 'user deletion', deadline);
      if (deleted.deleted) {
        this.userIdValue = null;
        return;
      }
    }
    throw new Error(`persona ${this.username} remained after three deletion attempts`);
  }

  private async resolveUserId(): Promise<void> {
    if (this.userIdValue) return;
    const users = await expectJson<UserView[]>(await this.adminApi.get('/api/admin/users'));
    this.userIdValue = users.find((user) => user.username === this.username)?.id ?? null;
  }

  private async settleTaskIds(
    taskIds: readonly string[],
    label: string,
    deadline: AbsoluteDeadline = this.deadline,
  ): Promise<void> {
    for (const taskId of [...new Set(taskIds)]) {
      await waitForAgentTask(this.adminApi, taskId, {
        timeoutMs: deadline.remaining(`${label} task ${taskId}`, 60_000),
      });
    }
  }
}

export async function createStandardPersona(
  options: PersonaOptions,
): Promise<StandardPersonaLease> {
  const lease = new StandardPersonaLease(options);
  try {
    await lease.initialize(options);
    return lease;
  } catch (error) {
    try {
      await lease.cleanup(new AbsoluteDeadline(setupFailureCleanupBudgetMs));
    } catch (cleanupError) {
      throw aggregateErrorWithDiagnostics(
        `persona ${lease.username} setup and cleanup failed`,
        [asError(error), asError(cleanupError)],
      );
    }
    throw error;
  }
}

function imageGrantKey(imageId: string, serverId: string): string {
  return `${imageId}\u0000${serverId}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
