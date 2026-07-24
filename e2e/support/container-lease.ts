import type { APIRequestContext } from '@playwright/test';
import { ContainerDeadline } from './container-deadline.js';
import {
  waitForAgentTask,
  type AgentTaskRef,
  type AgentTaskView,
  type ContainerView,
} from './durable-api.js';
import { expectJson } from './http.js';
import { currentRunId } from './runtime-env.js';

export type ContainerRouteKind = 'owner' | 'admin';

export interface ContainerRouteLane {
  kind: ContainerRouteKind;
  api: APIRequestContext;
}

export interface ContainerLeaseInput {
  ownerApi: APIRequestContext;
  adminApi: APIRequestContext;
  ownerId: string;
  serverId: string;
  imageId: string;
  name: string;
  dataDirs?: Array<{
    sourceKind: 'local' | 'remote';
    sourceId: string;
    dirName: string;
    containerPath: string;
  }>;
}

export interface RunningContainerLease {
  task: AgentTaskView;
  view: ContainerView;
}

let leaseSequence = 0;

export function ownerContainerLane(api: APIRequestContext): ContainerRouteLane {
  return { kind: 'owner', api };
}

export function adminContainerLane(api: APIRequestContext): ContainerRouteLane {
  return { kind: 'admin', api };
}

export function containerCollectionPath(kind: ContainerRouteKind): string {
  return kind === 'admin' ? '/api/admin/v2/containers' : '/api/v2/containers';
}

export function containerResourcePath(kind: ContainerRouteKind, containerId: string): string {
  return `${containerCollectionPath(kind)}/${containerId}`;
}

export function uniqueContainerLeaseName(label: string): string {
  leaseSequence += 1;
  const runId = currentRunId()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 30);
  const safeLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 18);
  return `${runId}-${safeLabel}-${Date.now().toString(36)}-${leaseSequence.toString(36)}`.slice(
    0,
    64,
  );
}

export async function getContainerViaLane(
  lane: ContainerRouteLane,
  containerId: string,
  deadline?: ContainerDeadline,
): Promise<ContainerView | null> {
  const response = await lane.api.get(containerResourcePath(lane.kind, containerId), {
    timeout: deadline?.remaining(`get ${lane.kind} container ${containerId}`, 30_000),
  });
  if (response.status() === 404) return null;
  return expectJson<ContainerView>(response);
}

export async function listContainersViaLane(
  lane: ContainerRouteLane,
  serverId?: string,
  deadline?: ContainerDeadline,
): Promise<ContainerView[]> {
  const query = serverId ? `?serverId=${encodeURIComponent(serverId)}` : '';
  return expectJson<ContainerView[]>(
    await lane.api.get(`${containerCollectionPath(lane.kind)}${query}`, {
      timeout: deadline?.remaining(`list ${lane.kind} containers`, 30_000),
    }),
  );
}

export async function requestContainerActionViaLane(
  lane: ContainerRouteLane,
  containerId: string,
  action: 'start' | 'stop' | 'restart' | 'delete' | 'reconcile-ssh',
  deadline?: ContainerDeadline,
): Promise<AgentTaskRef> {
  return expectJson<AgentTaskRef>(
    await lane.api.post(`${containerResourcePath(lane.kind, containerId)}/actions/${action}`, {
      timeout: deadline?.remaining(`request ${lane.kind} container ${action}`, 30_000),
    }),
    201,
  );
}

export async function settleContainerActionViaLane(
  lane: ContainerRouteLane,
  taskObserverApi: APIRequestContext,
  containerId: string,
  action: 'start' | 'stop' | 'restart' | 'delete' | 'reconcile-ssh',
  deadline = new ContainerDeadline(120_000, `${lane.kind} container ${action}`),
): Promise<AgentTaskView> {
  const ref = await requestContainerActionViaLane(lane, containerId, action, deadline);
  return waitForAgentTask(taskObserverApi, ref.taskId, {
    kind: action === 'reconcile-ssh' ? 'container.ssh.ensure' : `container.${action}`,
    resourceId: containerId,
    timeoutMs: deadline.remaining(`settle ${action} task ${ref.taskId}`),
  });
}

export async function waitForContainerViaLane(
  lane: ContainerRouteLane,
  containerId: string,
  description: string,
  accept: (container: ContainerView) => boolean,
  deadline = new ContainerDeadline(60_000, `${lane.kind} container wait`),
): Promise<ContainerView> {
  let last: ContainerView | null = null;
  while (true) {
    deadline.remaining(`observe ${description}`);
    const response = await lane.api.get(containerResourcePath(lane.kind, containerId), {
      timeout: deadline.remaining(`get container while waiting for ${description}`, 30_000),
    });
    if (response.status() === 200) {
      last = await expectJson<ContainerView>(response);
      if (accept(last)) return last;
    } else if (response.status() !== 404) {
      await expectJson<unknown>(response);
    }
    await deadline.delay(`poll ${description}`, 500);
  }
}

export async function waitForContainerAbsentViaLane(
  lane: ContainerRouteLane,
  containerId: string,
  deadline = new ContainerDeadline(60_000, `${lane.kind} container absence`),
): Promise<void> {
  while (true) {
    deadline.remaining(`observe absence of ${containerId}`);
    if ((await getContainerViaLane(lane, containerId, deadline)) === null) return;
    await deadline.delay(`poll absence of ${containerId}`, 500);
  }
}

export class ContainerLease {
  readonly ownerLane: ContainerRouteLane;
  readonly adminLane: ContainerRouteLane;
  createTaskId: string | null = null;
  containerId: string | null = null;
  runtimeId: string | null = null;
  createTask: AgentTaskView | null = null;
  view: ContainerView | null = null;
  deleted = false;

  private createAttempted = false;

  constructor(readonly input: ContainerLeaseInput) {
    this.ownerLane = ownerContainerLane(input.ownerApi);
    this.adminLane = adminContainerLane(input.adminApi);
  }

  async createRunning(
    deadline = new ContainerDeadline(180_000, `create container lease ${this.input.name}`),
  ): Promise<RunningContainerLease> {
    await this.submitCreate(deadline);
    const task = await this.waitForCreateTask(deadline);
    const view = await this.waitUntilRunning(deadline);
    return { task, view };
  }

  async submitCreate(
    deadline = new ContainerDeadline(60_000, `submit container lease ${this.input.name}`),
  ): Promise<AgentTaskRef> {
    if (this.createAttempted) {
      throw new Error(`Container lease ${this.input.name} create was already attempted`);
    }
    this.createAttempted = true;
    const ref = await expectJson<AgentTaskRef>(
      await this.input.ownerApi.post(containerCollectionPath('owner'), {
        data: {
          serverId: this.input.serverId,
          imageId: this.input.imageId,
          name: this.input.name,
          ...(this.input.dataDirs ? { dataDirs: this.input.dataDirs } : {}),
        },
        timeout: deadline.remaining(`submit create for ${this.input.name}`, 30_000),
      }),
      201,
    );
    this.createTaskId = ref.taskId;

    const pending = await expectJson<AgentTaskView>(
      await this.input.adminApi.get(`/api/admin/agent-tasks/${ref.taskId}`, {
        timeout: deadline.remaining(`inspect create task ${ref.taskId}`, 30_000),
      }),
    );
    this.captureContainerId(pending.resourceId, `create task ${ref.taskId}`);
    return ref;
  }

  async waitForCreateTask(
    deadline = new ContainerDeadline(180_000, `settle container lease ${this.input.name}`),
  ): Promise<AgentTaskView> {
    if (!this.createTaskId) {
      throw new Error(`Container lease ${this.input.name} has no submitted create task`);
    }
    const refTaskId = this.createTaskId;
    const task = await waitForAgentTask(this.input.adminApi, refTaskId, {
      kind: 'container.create',
      resourceId: this.requireContainerId(),
      timeoutMs: deadline.remaining(`settle create task ${refTaskId}`),
    });
    this.createTask = task;
    this.captureContainerId(task.resourceId, `settled create task ${refTaskId}`);
    return task;
  }

  async waitUntilRunning(
    deadline = new ContainerDeadline(90_000, `observe container lease ${this.input.name}`),
  ): Promise<ContainerView> {
    const view = await waitForContainerViaLane(
      this.ownerLane,
      this.requireContainerId(),
      'running after lease create',
      (container) =>
        container.runtime.bound &&
        container.runtime.status === 'running' &&
        container.powerIntent === 'running' &&
        container.activeTask === null,
      deadline,
    );
    this.assertLeaseIdentity(view);
    if (!view.runtime.runtimeId) {
      throw new Error(`Container lease ${view.id} is bound without a runtime ID`);
    }
    this.runtimeId = view.runtime.runtimeId;
    this.view = view;
    return view;
  }

  async cleanup(
    deadline = new ContainerDeadline(180_000, `cleanup container lease ${this.input.name}`),
  ): Promise<AgentTaskView | null> {
    if (this.deleted) return null;
    const containerId = this.containerId ?? (await this.recoverContainerId(deadline));
    if (!containerId) return null;

    let container = await getContainerViaLane(this.adminLane, containerId, deadline);
    if (!container) {
      this.deleted = true;
      return null;
    }
    this.assertLeaseIdentity(container);

    if (container.activeTask?.status === 'pending') {
      await this.waitForTaskTerminal(container.activeTask.id, deadline);
    }
    container = await waitForContainerViaLane(
      this.adminLane,
      containerId,
      'delete availability during lease cleanup',
      (candidate) => candidate.actions.delete?.enabled === true && candidate.activeTask === null,
      deadline,
    );
    this.assertLeaseIdentity(container);

    const deletion = await this.requestCleanupDelete(containerId, deadline);
    if (!deletion) return null;
    const task = await waitForAgentTask(this.input.adminApi, deletion.taskId, {
      kind: 'container.delete',
      resourceId: containerId,
      timeoutMs: deadline.remaining(`settle cleanup delete task ${deletion.taskId}`),
    });
    await waitForContainerAbsentViaLane(this.adminLane, containerId, deadline);
    this.deleted = true;
    return task;
  }

  markDeleted(): void {
    this.deleted = true;
  }

  requireContainerId(): string {
    if (!this.containerId) {
      throw new Error(
        `Container lease ${this.input.name} has no captured container ID; createTaskId=${String(this.createTaskId)}`,
      );
    }
    return this.containerId;
  }

  private captureContainerId(containerId: string, source: string): void {
    if (!containerId) throw new Error(`${source} did not expose a container resource ID`);
    if (this.containerId && this.containerId !== containerId) {
      throw new Error(
        `Container lease ${this.input.name} changed ID from ${this.containerId} to ${containerId} via ${source}`,
      );
    }
    this.containerId = containerId;
  }

  private assertLeaseIdentity(container: ContainerView): void {
    if (
      container.id !== this.requireContainerId() ||
      container.ownerId !== this.input.ownerId ||
      container.serverId !== this.input.serverId ||
      container.name !== this.input.name
    ) {
      throw new Error(
        `Refusing to operate on container that does not match lease ${this.input.name}: ${JSON.stringify(
          {
            expected: {
              id: this.containerId,
              ownerId: this.input.ownerId,
              serverId: this.input.serverId,
              name: this.input.name,
            },
            actual: {
              id: container.id,
              ownerId: container.ownerId,
              serverId: container.serverId,
              name: container.name,
            },
          },
        )}`,
      );
    }
  }

  private async recoverContainerId(deadline: ContainerDeadline): Promise<string | null> {
    if (!this.createAttempted) return null;
    const recoveryEndsAt = Math.min(deadline.expiresAt, Date.now() + 15_000);
    while (Date.now() < recoveryEndsAt) {
      deadline.remaining(`recover container ID for ${this.input.name}`);
      if (this.createTaskId) {
        const taskResponse = await this.input.adminApi.get(
          `/api/admin/agent-tasks/${this.createTaskId}`,
          {
            timeout: deadline.remaining(`inspect recovery task ${this.createTaskId}`, 30_000),
          },
        );
        if (taskResponse.status() === 200) {
          const task = await expectJson<AgentTaskView>(taskResponse);
          if (task.resourceId) {
            this.captureContainerId(task.resourceId, `recovered task ${task.id}`);
            return this.containerId;
          }
        } else if (taskResponse.status() !== 404) {
          await expectJson<unknown>(taskResponse);
        }
      }

      const candidates = (
        await listContainersViaLane(this.adminLane, this.input.serverId, deadline)
      ).filter(
        (candidate) =>
          candidate.ownerId === this.input.ownerId && candidate.name === this.input.name,
      );
      if (candidates.length > 1) {
        throw new Error(
          `Container lease recovery for ${this.input.name} is ambiguous: ${candidates
            .map((candidate) => candidate.id)
            .join(', ')}`,
        );
      }
      if (candidates.length === 1) {
        this.captureContainerId(candidates[0].id, 'admin list recovery');
        this.assertLeaseIdentity(candidates[0]);
        return this.containerId;
      }
      await deadline.delay(`poll container lease recovery for ${this.input.name}`, 500);
    }
    return null;
  }

  private async waitForTaskTerminal(
    taskId: string,
    deadline: ContainerDeadline,
  ): Promise<AgentTaskView> {
    while (true) {
      deadline.remaining(`wait for active task ${taskId} before cleanup`);
      const task = await expectJson<AgentTaskView>(
        await this.input.adminApi.get(`/api/admin/agent-tasks/${taskId}`, {
          timeout: deadline.remaining(`inspect active task ${taskId}`, 30_000),
        }),
      );
      if (task.status !== 'pending') return task;
      await deadline.delay(`poll active task ${taskId} before cleanup`, 500);
    }
  }

  private async requestCleanupDelete(
    containerId: string,
    deadline: ContainerDeadline,
  ): Promise<AgentTaskRef | null> {
    const ownerResponse = await this.input.ownerApi.post(
      `${containerResourcePath('owner', containerId)}/actions/delete`,
      { timeout: deadline.remaining(`request owner cleanup delete for ${containerId}`, 30_000) },
    );
    if (ownerResponse.status() === 201) return expectJson<AgentTaskRef>(ownerResponse, 201);
    if (![401, 403, 404].includes(ownerResponse.status())) {
      return expectJson<AgentTaskRef>(ownerResponse, 201);
    }

    const adminView = await getContainerViaLane(this.adminLane, containerId, deadline);
    if (!adminView) {
      this.deleted = true;
      return null;
    }
    this.assertLeaseIdentity(adminView);
    return expectJson<AgentTaskRef>(
      await this.input.adminApi.post(
        `${containerResourcePath('admin', containerId)}/actions/delete`,
        { timeout: deadline.remaining(`request admin cleanup delete for ${containerId}`, 30_000) },
      ),
      201,
    );
  }
}
