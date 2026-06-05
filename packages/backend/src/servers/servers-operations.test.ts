import {
  GpuGrantMode,
  AgentCommandKind,
  OperationKind,
  OperationStatus,
  ServerStatus,
} from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { ServersService } from './servers.service.js';

function makeService() {
  const server = {
    id: 'server-a',
    name: 'Server A',
    status: ServerStatus.Online,
    defaultDiskBytes: 0,
    defaultCpuMillis: 0,
    defaultMemBytes: 0,
    defaultGpuMode: GpuGrantMode.None,
    defaultGpuIndices: [],
  };
  const disk = { id: 'disk-a', serverId: 'server-a', mountPoint: '/data', label: 'data' };
  const serversRepo = {
    findOne: vi.fn().mockResolvedValue(server),
    save: vi.fn(async (input) => input),
  };
  const dataDisksRepo = {
    find: vi.fn().mockResolvedValue([disk]),
    findOne: vi.fn().mockResolvedValue(null),
    create: vi.fn((input) => ({ ...input, id: input.id ?? 'disk-created' })),
    save: vi.fn(async (input) => input),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const dataDirectoriesRepo = {
    findOne: vi.fn().mockResolvedValue(null),
  };
  const agentGateway = {
    isOnline: vi.fn().mockReturnValue(true),
    rpc: vi.fn().mockResolvedValue({ exists: true, isXfs: true, fsType: 'xfs' }),
    stateCache: {
      getRuntimeBlockReason: vi.fn().mockReturnValue({ enabled: true }),
      get: vi.fn().mockReturnValue({ disks: [], gpus: [], dockerDaemon: null, runtimeReady: true, lastUpdated: Date.now() }),
    },
  };
  const accessResolver = {
    invalidateAll: vi.fn(),
    invalidateUser: vi.fn(),
    getUsersWithServerAccess: vi.fn().mockResolvedValue(['user-a']),
    resolveServer: vi.fn().mockResolvedValue({ diskBytes: 4096 }),
  };
  const usersService = {
    getNumericIdsByUserIds: vi.fn().mockResolvedValue(new Map([['user-a', 1001]])),
  };
  const operationsService = {
    dispatchAgentCommand: vi.fn().mockResolvedValue({
      operationId: 'operation-a',
      status: OperationStatus.Queued,
      result: null,
    }),
  };
  const quotaDispatchService = { apply: vi.fn().mockResolvedValue(undefined) };
  const service = new ServersService(
    serversRepo as never,
    dataDisksRepo as never,
    dataDirectoriesRepo as never,
    { findOne: vi.fn().mockResolvedValue(null) } as never,
    agentGateway as never,
    accessResolver as never,
    usersService as never,
    operationsService as never,
    quotaDispatchService as never,
  );
  return {
    service,
    server,
    disk,
    serversRepo,
    dataDisksRepo,
    dataDirectoriesRepo,
    agentGateway,
    accessResolver,
    operationsService,
    quotaDispatchService,
  };
}

describe('ServersService durable disk and quota dispatch', () => {
  it('addDisk uses direct checkDisk only as preflight and queues disk.apply through operations', async () => {
    const { service, dataDisksRepo, agentGateway, operationsService } = makeService();

    await expect(service.addDisk('server-a', '/data', 'data')).resolves.toMatchObject({
      serverId: 'server-a',
      mountPoint: '/data',
      label: 'data',
      operationId: 'operation-a',
      operationStatus: OperationStatus.Queued,
    });

    expect(agentGateway.rpc).toHaveBeenCalledWith('server-a', 'checkDisk', { mountPoint: '/data' });
    expect(agentGateway.rpc).not.toHaveBeenCalledWith('server-a', 'applyDataDisk', expect.anything());
    expect(dataDisksRepo.save).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'server-a', mountPoint: '/data' }));
    expect(operationsService.dispatchAgentCommand).toHaveBeenCalledWith({
      operationKind: OperationKind.DiskApply,
      commandKind: AgentCommandKind.DiskApply,
      resourceType: 'data_disk',
      resourceId: expect.any(String),
      serverId: 'server-a',
      requestedBy: null,
      payload: expect.objectContaining({ mountPoint: '/data', label: 'data' }),
    });
  });

  it('removeDisk queues disk.remove after guard checks and leaves desired-state removal to operation persistence', async () => {
    const { service, dataDisksRepo, accessResolver, operationsService } = makeService();
    dataDisksRepo.findOne.mockResolvedValueOnce({ id: 'disk-a', serverId: 'server-a', mountPoint: '/data', label: null });

    await expect(service.removeDisk('server-a', 'disk-a')).resolves.toEqual({
      ok: true,
      operationId: 'operation-a',
      status: OperationStatus.Queued,
    });

    expect(dataDisksRepo.remove).not.toHaveBeenCalled();
    expect(accessResolver.invalidateAll).not.toHaveBeenCalled();
    expect(operationsService.dispatchAgentCommand).toHaveBeenCalledWith(expect.objectContaining({
      operationKind: OperationKind.DiskApply,
      commandKind: AgentCommandKind.DiskRemove,
      resourceType: 'data_disk',
      resourceId: 'disk-a',
      serverId: 'server-a',
      requestedBy: null,
      payload: { diskId: 'disk-a' },
      beforePersist: expect.any(Function),
    }));
  });

  it('removeDisk rejects when the disk still has data directories', async () => {
    const { service, dataDisksRepo, dataDirectoriesRepo, operationsService } = makeService();
    dataDisksRepo.findOne.mockResolvedValueOnce({ id: 'disk-a', serverId: 'server-a', mountPoint: '/data', label: null });
    dataDirectoriesRepo.findOne.mockResolvedValueOnce({ id: 'dir-a', sourceKind: 'local', sourceId: 'disk-a', name: 'project' });

    await expect(service.removeDisk('server-a', 'disk-a')).rejects.toThrow(
      'This disk still has data directories; delete those data directories first',
    );
    expect(operationsService.dispatchAgentCommand).not.toHaveBeenCalled();
  });

  it('updateDefaults recomputes quota desired state through QuotaDispatchService', async () => {
    const { service, server, serversRepo, accessResolver, quotaDispatchService } = makeService();
    serversRepo.findOne.mockResolvedValue(server);

    await expect(service.updateDefaults('server-a', { defaultDiskBytes: 4096 }))
      .resolves
      .toMatchObject({ defaultDiskBytes: 4096 });

    expect(accessResolver.invalidateUser).toHaveBeenCalledWith('user-a');
    expect(quotaDispatchService.apply).toHaveBeenCalledWith({
      serverId: 'server-a',
      userId: 'user-a',
      numericUserId: 1001,
      diskBytes: 4096,
      requestedBy: null,
    });
  });
});
