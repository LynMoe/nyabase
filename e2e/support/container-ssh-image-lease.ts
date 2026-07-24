import type { APIRequestContext } from '@playwright/test';
import { ContainerDeadline } from './container-deadline.js';
import { waitForAgentTask, type AgentTaskView } from './durable-api.js';
import { expectJson } from './http.js';
import { currentRunId } from './runtime-env.js';

interface ImageRuntimeOverrides {
  uid: number;
  entrypoint: string[] | null;
  cmd: string[] | null;
  init: boolean;
}

interface ImageView {
  id: string;
  name: string;
  dockerImage: string;
  runtimeOverrides: ImageRuntimeOverrides;
  isActive: boolean;
  deleting: boolean;
  disableSsh: boolean;
}

interface ImageTaskRef {
  taskId: string;
  serverId: string;
}

interface ImagePullResponse {
  tasks: ImageTaskRef[];
  rejected: Array<{ serverId: string; message: string }>;
}

interface ImageStatusView {
  serverId: string;
  online: boolean;
  present: boolean;
}

export interface ContainerSshImageLeaseInput {
  adminApi: APIRequestContext;
  seedImageId: string;
  seedDockerImage: string;
  temporaryDockerImage: string;
  serverId: string;
  label: string;
}

let sshImageSequence = 0;

/**
 * A temporary logical image that uses the separately published immutable UI
 * workload tag but copies the seeded workload's runtime contract and enables
 * product-managed SSH. The Image API deliberately accepts tags only.
 */
export class ContainerSshImageLease {
  readonly name: string;
  readonly dockerImage: string;
  imageId: string | null = null;

  private createAttempted = false;

  constructor(readonly input: ContainerSshImageLeaseInput) {
    sshImageSequence += 1;
    const runId = currentRunId()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .slice(0, 36);
    const label = input.label
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .slice(0, 18);
    this.name = `${runId}-${label}-ssh-${sshImageSequence}`.slice(0, 128);
    this.dockerImage = input.temporaryDockerImage;
  }

  async setup(
    deadline = new ContainerDeadline(180_000, `setup SSH image ${this.name}`),
  ): Promise<ImageView> {
    this.createAttempted = true;
    const seed = await expectJson<ImageView>(
      await this.input.adminApi.get(`/api/admin/images/${this.input.seedImageId}`, {
        timeout: deadline.remaining(`read seed image ${this.input.seedImageId}`, 30_000),
      }),
    );
    if (seed.dockerImage !== this.input.seedDockerImage || seed.disableSsh !== true) {
      throw new Error(
        `Seed image ${seed.id} no longer has the expected immutable SSH-disabled identity`,
      );
    }

    const image = await expectJson<ImageView>(
      await this.input.adminApi.post('/api/admin/images', {
        data: {
          name: this.name,
          dockerImage: this.dockerImage,
          runtimeOverrides: seed.runtimeOverrides,
          description: `real CPU E2E SSH image for ${this.input.label}`,
          disableSsh: false,
        },
        timeout: deadline.remaining(`create SSH image ${this.name}`, 30_000),
      }),
      201,
    );
    this.imageId = image.id;
    if (
      image.dockerImage !== this.dockerImage ||
      image.disableSsh !== false ||
      JSON.stringify(image.runtimeOverrides) !== JSON.stringify(seed.runtimeOverrides)
    ) {
      throw new Error(`Temporary SSH image ${image.id} changed the seeded runtime identity`);
    }

    const pull = await expectJson<ImagePullResponse>(
      await this.input.adminApi.post(`/api/admin/images/${image.id}/pull`, {
        data: { serverIds: [this.input.serverId] },
        timeout: deadline.remaining(`pull SSH image ${image.id}`, 30_000),
      }),
      201,
    );
    if (pull.rejected.length !== 0 || pull.tasks.length !== 1) {
      throw new Error(`SSH image pull did not produce exactly one accepted real-Agent task`);
    }
    const task = await waitForAgentTask(this.input.adminApi, pull.tasks[0].taskId, {
      kind: 'image.ensure_present',
      resourceId: image.id,
      timeoutMs: deadline.remaining(`settle SSH image pull ${pull.tasks[0].taskId}`, 120_000),
    });
    if (task.serverId !== this.input.serverId) {
      throw new Error(
        `SSH image pull settled on ${task.serverId}, expected ${this.input.serverId}`,
      );
    }
    await waitForImageStatus(this.input.adminApi, image.id, this.input.serverId, true, deadline);
    return image;
  }

  async cleanup(
    deadline = new ContainerDeadline(240_000, `cleanup SSH image ${this.name}`),
  ): Promise<void> {
    const imageId = await this.resolveImageId(deadline);
    if (!imageId) return;

    while (true) {
      deadline.remaining(`delete temporary SSH image ${imageId}`);
      const current = await this.input.adminApi.get(`/api/admin/images/${imageId}`, {
        timeout: deadline.remaining(`read temporary SSH image ${imageId}`, 30_000),
      });
      if (current.status() === 404) break;
      await expectJson<ImageView>(current);

      const tasks = await expectJson<AgentTaskView[]>(
        await this.input.adminApi.get(
          `/api/admin/agent-tasks?resourceType=image&resourceId=${encodeURIComponent(imageId)}&limit=100`,
          { timeout: deadline.remaining(`list temporary SSH image tasks ${imageId}`, 30_000) },
        ),
      );
      const pending = tasks.filter((task) => task.status === 'pending');
      if (pending.length > 0) {
        for (const task of pending) {
          await waitForTaskTerminal(this.input.adminApi, task.id, deadline);
        }
        continue;
      }

      const deletion = await this.input.adminApi.delete(`/api/admin/images/${imageId}`, {
        timeout: deadline.remaining(`request temporary SSH image delete ${imageId}`, 30_000),
      });
      if (deletion.status() === 404) break;
      if (deletion.status() === 409) {
        await deadline.delay(`retry temporary SSH image delete ${imageId}`, 500);
        continue;
      }
      const result = await expectJson<{ tasks: ImageTaskRef[] }>(deletion, 202);
      for (const task of result.tasks) {
        await waitForAgentTask(this.input.adminApi, task.taskId, {
          kind: 'image.ensure_absent',
          resourceId: imageId,
          timeoutMs: deadline.remaining(`settle SSH image delete ${task.taskId}`, 120_000),
        });
      }
      await waitForImageAbsent(this.input.adminApi, imageId, deadline);
      break;
    }

    await waitForImageStatus(
      this.input.adminApi,
      this.input.seedImageId,
      this.input.serverId,
      true,
      deadline,
    );
  }

  private async resolveImageId(deadline: ContainerDeadline): Promise<string | null> {
    if (this.imageId) {
      const response = await this.input.adminApi.get(`/api/admin/images/${this.imageId}`, {
        timeout: deadline.remaining(`resolve SSH image ${this.imageId}`, 30_000),
      });
      if (response.status() === 200) return this.imageId;
      if (response.status() !== 404) await expectJson<unknown>(response);
    }
    if (!this.createAttempted) return null;
    const images = await expectJson<ImageView[]>(
      await this.input.adminApi.get('/api/admin/images', {
        timeout: deadline.remaining(`resolve SSH image ${this.name} by name`, 30_000),
      }),
    );
    const matches = images.filter((image) => image.name === this.name);
    if (matches.length > 1) {
      throw new Error(`Temporary SSH image name ${this.name} is ambiguous`);
    }
    return matches[0]?.id ?? null;
  }
}

async function waitForImageStatus(
  adminApi: APIRequestContext,
  imageId: string,
  serverId: string,
  present: boolean,
  deadline: ContainerDeadline,
): Promise<ImageStatusView> {
  while (true) {
    const statuses = await expectJson<ImageStatusView[]>(
      await adminApi.get(`/api/admin/images/${imageId}/status`, {
        timeout: deadline.remaining(`read image ${imageId} status`, 30_000),
      }),
    );
    const status = statuses.find((entry) => entry.serverId === serverId);
    if (status?.online && status.present === present) return status;
    await deadline.delay(`wait for image ${imageId} present=${String(present)}`, 500);
  }
}

async function waitForImageAbsent(
  adminApi: APIRequestContext,
  imageId: string,
  deadline: ContainerDeadline,
): Promise<void> {
  while (true) {
    const response = await adminApi.get(`/api/admin/images/${imageId}`, {
      timeout: deadline.remaining(`confirm temporary SSH image ${imageId} absence`, 30_000),
    });
    if (response.status() === 404) return;
    await expectJson<ImageView>(response);
    await deadline.delay(`wait for temporary SSH image ${imageId} absence`, 500);
  }
}

async function waitForTaskTerminal(
  adminApi: APIRequestContext,
  taskId: string,
  deadline: ContainerDeadline,
): Promise<AgentTaskView> {
  while (true) {
    const task = await expectJson<AgentTaskView>(
      await adminApi.get(`/api/admin/agent-tasks/${taskId}`, {
        timeout: deadline.remaining(`read image task ${taskId}`, 30_000),
      }),
    );
    if (task.status !== 'pending') return task;
    await deadline.delay(`wait for image task ${taskId}`, 500);
  }
}
