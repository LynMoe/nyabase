import type { APIRequestContext, APIResponse } from '@playwright/test';
import { ContainerDeadline } from './container-deadline.js';
import { waitForAgentTask, type AgentTaskRef, type AgentTaskView } from './durable-api.js';
import { aggregateErrorWithDiagnostics } from './error-diagnostics.mjs';
import { expectJson } from './http.js';
import { currentRunId } from './runtime-env.js';

interface MountSourceGrantView {
  id: string;
  scope: 'user';
  scopeId: string;
  sourceKind: 'local';
  sourceId: string;
  serverId: string;
  sourceIdentity: string;
}

interface DataDirCreateResult {
  id: string;
  resourceId: string;
  serverId: string;
  sourceKind: 'local';
  sourceId: string;
  name: string;
  hostPath: string;
  taskId: string;
}

export interface ContainerMountLeaseInput {
  adminApi: APIRequestContext;
  ownerApi: APIRequestContext;
  ownerId: string;
  serverId: string;
  sourceId: string;
  sourceIdentity: string;
  label: string;
  containerPath?: string;
}

let mountSequence = 0;

export class ContainerMountLease {
  readonly dirName: string;
  readonly containerPath: string;
  grantId: string | null = null;
  dataDirId: string | null = null;
  dataDirTaskId: string | null = null;

  private grantAttempted = false;
  private dataDirAttempted = false;

  constructor(readonly input: ContainerMountLeaseInput) {
    mountSequence += 1;
    const runId = currentRunId()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .slice(0, 28);
    const label = input.label
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .slice(0, 18);
    this.dirName = `${runId}-${label}-${Date.now().toString(36)}-${mountSequence}`.slice(0, 64);
    this.containerPath = input.containerPath ?? '/data';
    if (!this.containerPath.startsWith('/')) {
      throw new Error(`Container mount path must be absolute: ${this.containerPath}`);
    }
  }

  get mountInput(): {
    sourceKind: 'local';
    sourceId: string;
    dirName: string;
    containerPath: string;
  } {
    return {
      sourceKind: 'local',
      sourceId: this.input.sourceId,
      dirName: this.dirName,
      containerPath: this.containerPath,
    };
  }

  async setup(
    deadline = new ContainerDeadline(180_000, `setup container mount ${this.dirName}`),
  ): Promise<DataDirCreateResult> {
    this.grantAttempted = true;
    const grant = await expectJson<MountSourceGrantView>(
      await this.input.adminApi.post(
        `/api/admin/mount-sources/grants/local/${encodeURIComponent(this.input.sourceId)}`,
        {
          data: {
            scope: 'user',
            scopeId: this.input.ownerId,
            serverId: this.input.serverId,
          },
          timeout: deadline.remaining(`grant mount source ${this.input.sourceId}`, 30_000),
        },
      ),
      201,
    );
    this.grantId = grant.id;
    if (
      grant.scopeId !== this.input.ownerId ||
      grant.serverId !== this.input.serverId ||
      grant.sourceId !== this.input.sourceId ||
      grant.sourceIdentity !== this.input.sourceIdentity
    ) {
      throw new Error(
        `Mount source grant ${grant.id} does not match the requested physical source`,
      );
    }

    this.dataDirAttempted = true;
    const dataDir = await expectJson<DataDirCreateResult>(
      await this.input.ownerApi.post('/api/data-dirs', {
        data: {
          serverId: this.input.serverId,
          sourceKind: 'local',
          sourceId: this.input.sourceId,
          name: this.dirName,
        },
        timeout: deadline.remaining(`create DataDir ${this.dirName}`, 30_000),
      }),
      201,
    );
    this.dataDirId = dataDir.id;
    this.dataDirTaskId = dataDir.taskId;
    if (
      dataDir.resourceId !== dataDir.id ||
      dataDir.serverId !== this.input.serverId ||
      dataDir.sourceId !== this.input.sourceId ||
      dataDir.name !== this.dirName
    ) {
      throw new Error(`DataDir ${dataDir.id} does not match mount lease ${this.dirName}`);
    }
    await waitForAgentTask(this.input.adminApi, dataDir.taskId, {
      kind: 'datadir.ensure',
      resourceId: dataDir.id,
      timeoutMs: deadline.remaining(`settle DataDir ${dataDir.id}`, 120_000),
    });
    return dataDir;
  }

  async cleanup(
    deadline = new ContainerDeadline(180_000, `cleanup container mount ${this.dirName}`),
  ): Promise<void> {
    const errors: unknown[] = [];
    if (this.dataDirAttempted) {
      await attempt(errors, async () => {
        if (this.dataDirTaskId) {
          await waitForTerminalTask(this.input.adminApi, this.dataDirTaskId, deadline);
        }
        const ownerResponse = await this.input.ownerApi.delete(
          `/api/data-dirs/${encodeURIComponent(this.input.serverId)}/${encodeURIComponent(this.input.sourceId)}/${encodeURIComponent(this.dirName)}?sourceKind=local`,
          { timeout: deadline.remaining(`delete owner DataDir ${this.dirName}`, 30_000) },
        );
        const response = [401, 403].includes(ownerResponse.status())
          ? await this.input.adminApi.delete(
              `/api/admin/data-dirs/${encodeURIComponent(this.input.serverId)}/${encodeURIComponent(this.input.sourceId)}/${encodeURIComponent(this.dirName)}?sourceKind=local&userId=${encodeURIComponent(this.input.ownerId)}`,
              { timeout: deadline.remaining(`delete admin DataDir ${this.dirName}`, 30_000) },
            )
          : ownerResponse;
        if (response.status() === 404) return;
        const ref = await expectJson<AgentTaskRef>(response);
        await waitForAgentTask(this.input.adminApi, ref.taskId, {
          kind: 'datadir.absent',
          ...(this.dataDirId ? { resourceId: this.dataDirId } : {}),
          timeoutMs: deadline.remaining(`settle DataDir delete ${ref.taskId}`, 120_000),
        });
      });
    }
    if (this.grantAttempted) {
      await attempt(errors, async () => {
        const response = await this.input.adminApi.delete(
          `/api/admin/mount-sources/grants/local/${encodeURIComponent(this.input.sourceId)}/user/${encodeURIComponent(this.input.ownerId)}?serverId=${encodeURIComponent(this.input.serverId)}`,
          { timeout: deadline.remaining(`delete mount grant ${this.dirName}`, 30_000) },
        );
        await expectStatus(
          response,
          [204, 404],
          `delete mount grant ${this.grantId ?? this.dirName}`,
        );
      });
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw aggregateErrorWithDiagnostics(
        `Container mount ${this.dirName} cleanup had multiple failures`,
        errors,
      );
    }
  }
}

async function waitForTerminalTask(
  adminApi: APIRequestContext,
  taskId: string,
  deadline: ContainerDeadline,
): Promise<AgentTaskView> {
  while (true) {
    const task = await expectJson<AgentTaskView>(
      await adminApi.get(`/api/admin/agent-tasks/${taskId}`, {
        timeout: deadline.remaining(`inspect DataDir task ${taskId}`, 30_000),
      }),
    );
    if (task.status !== 'pending') return task;
    await deadline.delay(`wait for DataDir task ${taskId}`, 500);
  }
}

async function expectStatus(
  response: APIResponse,
  statuses: readonly number[],
  description: string,
): Promise<void> {
  if (statuses.includes(response.status())) return;
  throw new Error(
    `${description} returned ${response.status()}, expected ${statuses.join(' or ')}; response body withheld`,
  );
}

async function attempt(errors: unknown[], operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(error);
  }
}
