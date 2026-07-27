import {
  AgentTaskKind,
  AgentTaskStatus,
  ContainerPhase,
  ContainerStatus,
  LABEL,
} from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { AgentGateway } from '../agent-gateway.js';

function gatewayWith(overrides: {
  transactions?: unknown;
  infrastructure?: unknown;
  containers?: unknown;
  storage?: unknown;
  workflow?: unknown;
  codec?: unknown;
  stateCache?: unknown;
}): AgentGateway {
  const args = Array.from({ length: 25 }, () => ({}));
  args[1] = overrides.transactions ?? {};
  args[2] = overrides.infrastructure ?? {};
  args[3] = overrides.containers ?? {};
  args[4] = overrides.storage ?? {};
  args[5] = overrides.workflow ?? {};
  args[11] = overrides.codec ?? {};
  args[22] = { gatewayId: 'gateway:test' };
  args[24] = overrides.stateCache ?? {};
  return Reflect.construct(AgentGateway, args) as AgentGateway;
}

describe('AgentGateway bounded batch hot paths', () => {
  it('loads 64 RemoteFS bootstrap assignments, tasks, and products in three fixed queries', async () => {
    const assignments = Array.from({ length: 64 }, (_, index) => ({
      id: `assignment-${index}`,
      remoteFsMountId: `mount-${index}`,
      serverId: 'server-a',
      desiredState: 'active',
      lastTaskId: `task-${index}`,
    }));
    const listAssignmentsForServer = vi.fn().mockResolvedValue(assignments);
    const listRemoteFsMountsByIds = vi.fn().mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        desiredState: 'active',
        hostMountPoint: `/mnt/remote-fs/${id}`,
        options: 'ro',
        params: {
          type: 'nfs',
          nfsServer: 'nfs.internal',
          exportPath: `/${id}`,
          version: '4.2',
        },
      })));
    const findTasks = vi.fn().mockImplementation(async (ids: string[]) =>
      new Map(ids.map((id, index) => [id, {
        id,
        kind: AgentTaskKind.RemoteFsEnsure,
        status: AgentTaskStatus.Succeeded,
        serverId: 'server-a',
        resourceType: 'remote_fs_mount',
        resourceId: `mount-${index}`,
      }])));
    const gateway = gatewayWith({
      transactions: { run: (work: (tx: unknown) => unknown) => work({}) },
      storage: { listAssignmentsForServer, listRemoteFsMountsByIds },
      workflow: { findTasks },
      codec: {
        forRemoteFsBootstrap: (mounts: unknown[]) => mounts,
      },
    });

    const result = await (gateway as unknown as {
      activeRemoteFsBootstrap(serverId: string): Promise<unknown[]>;
    }).activeRemoteFsBootstrap('server-a');
    expect(result).toHaveLength(64);
    expect(listAssignmentsForServer).toHaveBeenCalledOnce();
    expect(findTasks).toHaveBeenCalledOnce();
    expect(listRemoteFsMountsByIds).toHaveBeenCalledOnce();
  });

  it('projects 128 routable containers with one aggregate and one mount batch', async () => {
    const snapshots = Array.from({ length: 128 }, (_, index) => ({
      runtime: {
        runtimeId: `runtime-${index}`,
        ip: `10.0.0.${index + 1}`,
        serverId: 'server-a',
        specGeneration: '1',
        quotaPaths: [],
      },
      status: ContainerStatus.Running,
      sshServer: { enabled: false, status: 'disabled', user: 'root', port: 22 },
      labels: {
        [LABEL.CONTAINER_ID]: `container-${index}`,
        [LABEL.RUNTIME_SPEC_HASH]: `hash-${index}`,
      },
    }));
    const findByIds = vi.fn().mockImplementation(async (ids: string[]) =>
      ids.map((id, index) => ({
        id,
        lifecyclePhase: ContainerPhase.Active,
        activeTaskId: null,
        boundRuntimeId: `runtime-${index}`,
        runtimeSpecHash: `hash-${index}`,
      })));
    const listMounts = vi.fn().mockResolvedValue([]);
    const listAssignmentsForServer = vi.fn().mockResolvedValue([]);
    const gateway = gatewayWith({
      containers: { findByIds, listMounts },
      storage: { listAssignmentsForServer },
    });

    const result = await (gateway as unknown as {
      routableContainers(
        serverId: string,
        containers: unknown[],
        mounts: unknown[],
      ): Promise<unknown[]>;
    }).routableContainers('server-a', snapshots, []);
    expect(result).toHaveLength(128);
    expect(findByIds).toHaveBeenCalledOnce();
    expect(listMounts).toHaveBeenCalledOnce();
    expect(listAssignmentsForServer).not.toHaveBeenCalled();
  });

  it('validates 128 reported RemoteFS mounts with one product batch', async () => {
    const listRemoteFsMountsByIds = vi.fn().mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        desiredState: 'active',
        hostMountPoint: `/mnt/remote-fs/${id}`,
      })));
    const listAssignmentsForServer = vi.fn().mockImplementation(async () =>
      Array.from({ length: 128 }, (_, index) => ({
        remoteFsMountId: `mount-${index}`,
        desiredState: 'active',
      })));
    const gateway = gatewayWith({
      infrastructure: {
        findServerById: vi.fn().mockResolvedValue({
          macvlanCidr: '10.0.0.0/24',
          macvlanGateway: '10.0.0.1',
        }),
      },
      containers: { findByIds: vi.fn(), activeNetworkClaims: vi.fn() },
      storage: { listRemoteFsMountsByIds, listAssignmentsForServer },
      stateCache: { get: () => ({ dockerRoot: '/var/lib/nyabase-docker' }) },
    });
    const remoteFsMounts = Array.from({ length: 128 }, (_, index) => ({
      id: `mount-${index}`,
      hostMountPoint: `/mnt/remote-fs/mount-${index}`,
      status: 'mounted',
      lastCheckedAt: 1,
    }));

    await expect((gateway as unknown as {
      validStateReportInventory(serverId: string, payload: unknown): Promise<boolean>;
    }).validStateReportInventory('server-a', {
      containers: [],
      disks: [],
      xfsProjects: [],
      remoteFsMounts,
      dataDirs: [],
    })).resolves.toBe(true);
    expect(listRemoteFsMountsByIds).toHaveBeenCalledOnce();
    expect(listAssignmentsForServer).toHaveBeenCalledOnce();
  });
});
