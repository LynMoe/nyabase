import { describe, expect, it, vi } from 'vitest';
import { In } from 'typeorm';
import {
  AgentCommandKind,
  ContainerPhase,
  ContainerStatus,
  OperationKind,
} from '@nyabase/common';
import { LifecycleHookRegistryService } from './lifecycle-hook-registry.service.js';

function makeRepo<T>(rows: T[] = []) {
  return {
    find: vi.fn(async () => rows),
  };
}

describe('LifecycleHookRegistryService SSH key sync', () => {
  it('enqueues V2 reconcile operations for active running SSH-enabled owner containers', async () => {
    const orchestrator = {
      enqueueReconcileTask: vi.fn(),
      createAgentCommand: vi.fn(async (input) => {
        await input.beforePersist?.({
          findOne: vi.fn(async () => ({
            containerId: 'container-a',
            phase: ContainerPhase.Active,
            activeOperationId: null,
            boundRuntimeId: 'runtime-a',
          })),
          update: vi.fn(),
        }, { operationId: 'op-a', commandId: 'cmd-a', idempotencyKey: 'idem-a' });
        return { operationId: 'op-a', commandId: 'cmd-a', status: 'queued' };
      }),
    };
    const containersRepo = makeRepo([
      { id: 'container-a', serverId: 'server-a', ownerId: 'user-a', deletedAt: null },
      { id: 'container-disabled', serverId: 'server-a', ownerId: 'user-a', deletedAt: null },
      { id: 'container-stopped', serverId: 'server-a', ownerId: 'user-a', deletedAt: null },
      { id: 'container-busy', serverId: 'server-a', ownerId: 'user-a', deletedAt: null },
    ]);
    const desiredRepo = makeRepo([
      { containerId: 'container-a', sshEnabled: true },
      { containerId: 'container-stopped', sshEnabled: true },
      { containerId: 'container-busy', sshEnabled: true },
    ]);
    const lifecycleRepo = makeRepo([
      { containerId: 'container-a', phase: ContainerPhase.Active, activeOperationId: null, boundRuntimeId: 'runtime-a' },
      { containerId: 'container-stopped', phase: ContainerPhase.Active, activeOperationId: null, boundRuntimeId: 'runtime-stopped' },
      { containerId: 'container-busy', phase: ContainerPhase.Active, activeOperationId: 'op-busy', boundRuntimeId: 'runtime-busy' },
    ]);
    const sshKeysRepo = makeRepo([
      { keyText: 'ssh-ed25519 AAAA key-a' },
      { keyText: 'ssh-ed25519 BBBB key-b' },
    ]);
    const agentGateway = {
      stateCache: {
        getContainerByContainerId: vi.fn((_serverId: string, containerId: string) => {
          if (containerId === 'container-a') return { status: ContainerStatus.Running };
          if (containerId === 'container-stopped') return { status: ContainerStatus.Exited };
          if (containerId === 'container-busy') return { status: ContainerStatus.Running };
          return undefined;
        }),
      },
    };
    const service = new LifecycleHookRegistryService(
      orchestrator as never,
      containersRepo as never,
      desiredRepo as never,
      lifecycleRepo as never,
      sshKeysRepo as never,
      agentGateway as never,
    );

    await service.enqueueUserSshKeyChange('user-a');

    expect(desiredRepo.find).toHaveBeenCalledWith({ where: { containerId: In(['container-a', 'container-disabled', 'container-stopped', 'container-busy']), sshEnabled: true } });
    expect(orchestrator.createAgentCommand).toHaveBeenCalledTimes(1);
    expect(orchestrator.createAgentCommand).toHaveBeenCalledWith(expect.objectContaining({
      operationKind: OperationKind.ContainerReconcileSsh,
      commandKind: AgentCommandKind.RuntimeContainerSshApply,
      serverId: 'server-a',
      resourceType: 'container',
      resourceId: 'container-a',
      requestedBy: 'user-a',
      resourceKey: 'container:container-a',
      request: { action: 'sshKeySync', keyCount: 2 },
      payload: {
        runtimeId: 'runtime-a',
        publicKeys: ['ssh-ed25519 AAAA key-a', 'ssh-ed25519 BBBB key-b'],
      },
      beforePersist: expect.any(Function),
    }));
  });
});
