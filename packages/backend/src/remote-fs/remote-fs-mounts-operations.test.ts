import {
  AuditAction,
  AgentCommandKind,
  OperationKind,
  OperationStatus,
  RemoteFsType,
} from '@nyabase/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataSource, Repository } from 'typeorm';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsRuntimeObservationEntity } from '../entities/remote-fs-runtime-observation.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { RemoteFsMountsService } from './remote-fs-mounts.service.js';

describe('RemoteFsMountsService durable operation dispatch', () => {
  let dataSource: DataSource;
  let mountsRepo: Repository<RemoteFsMountEntity>;
  let assignmentsRepo: Repository<RemoteFsServerAssignmentEntity>;
  let service: RemoteFsMountsService;
  let operationsService: { dispatchAgentCommand: ReturnType<typeof vi.fn> };
  let auditService: { log: ReturnType<typeof vi.fn> };
  let accessResolver: { invalidateAll: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        ContainerMountEntity,
        DataDirectoryEntity,
        RemoteFsMountEntity,
        RemoteFsRuntimeObservationEntity,
        RemoteFsServerAssignmentEntity,
      ],
      synchronize: true,
    });
    await dataSource.initialize();
    mountsRepo = dataSource.getRepository(RemoteFsMountEntity);
    assignmentsRepo = dataSource.getRepository(RemoteFsServerAssignmentEntity);
    operationsService = {
      dispatchAgentCommand: vi.fn(async (input) => ({
        operationId: `operation-${input.commandKind}`,
        status: OperationStatus.Queued,
        result: null,
      })),
    };
    auditService = { log: vi.fn().mockResolvedValue(undefined) };
    accessResolver = { invalidateAll: vi.fn() };
    service = new RemoteFsMountsService(
      mountsRepo,
      assignmentsRepo,
      dataSource.getRepository(RemoteFsRuntimeObservationEntity),
      dataSource.getRepository(ContainerMountEntity),
      dataSource.getRepository(DataDirectoryEntity),
      auditService as never,
      accessResolver as never,
      operationsService as never,
    );
    await mountsRepo.save(mountsRepo.create({
      id: 'remote-a',
      name: 'nfs-a',
      displayName: null,
      description: null,
      type: RemoteFsType.Nfs,
      hostMountPoint: '/mnt/remote-a',
      options: 'rw',
      params: { type: RemoteFsType.Nfs, nfsServer: 'nfs.example', exportPath: '/srv' },
    }));
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('assignServer persists desired assignment and queues remote_fs.apply', async () => {
    await expect(service.assignServer('actor-a', 'remote-a', 'server-a'))
      .resolves
      .toMatchObject({
        remoteFsMountId: 'remote-a',
        serverId: 'server-a',
        operationId: `operation-${AgentCommandKind.RemoteFsApply}`,
      });

    await expect(assignmentsRepo.count()).resolves.toBe(1);
    expect(accessResolver.invalidateAll).toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledWith(
      'actor-a',
      AuditAction.AssignRemoteFsServer,
      'remote-a',
      'remote_fs_mount',
      { serverId: 'server-a' },
    );
    expect(operationsService.dispatchAgentCommand).toHaveBeenCalledWith({
      operationKind: OperationKind.RemoteFsApply,
      commandKind: AgentCommandKind.RemoteFsApply,
      serverId: 'server-a',
      resourceType: 'remote_fs_mount',
      resourceId: 'remote-a',
      requestedBy: 'actor-a',
      payload: {
        id: 'remote-a',
        hostMountPoint: '/mnt/remote-a',
        options: 'rw',
        params: { type: RemoteFsType.Nfs, nfsServer: 'nfs.example', exportPath: '/srv' },
      },
    });
  });

  it('unassignServer queues remote_fs.remove before desired assignment removal is persisted', async () => {
    await assignmentsRepo.save(assignmentsRepo.create({
      id: 'assignment-a',
      remoteFsMountId: 'remote-a',
      serverId: 'server-a',
    }));

    await expect(service.unassignServer('actor-a', 'remote-a', 'server-a'))
      .resolves
      .toEqual({ ok: true, operationIds: [`operation-${AgentCommandKind.RemoteFsRemove}`] });

    await expect(assignmentsRepo.count()).resolves.toBe(1);
    expect(operationsService.dispatchAgentCommand).toHaveBeenCalledWith(expect.objectContaining({
      operationKind: OperationKind.RemoteFsApply,
      commandKind: AgentCommandKind.RemoteFsRemove,
      serverId: 'server-a',
      resourceType: 'remote_fs_mount',
      resourceId: 'remote-a',
      requestedBy: 'actor-a',
      payload: { id: 'remote-a', force: true },
      request: { scope: 'assignment', mountId: 'remote-a', serverId: 'server-a' },
      beforePersist: expect.any(Function),
    }));
  });

  it('remove dispatches remove operations for assigned servers before desired mount removal is persisted', async () => {
    await assignmentsRepo.save([
      assignmentsRepo.create({ id: 'assignment-a', remoteFsMountId: 'remote-a', serverId: 'server-a' }),
      assignmentsRepo.create({ id: 'assignment-b', remoteFsMountId: 'remote-a', serverId: 'server-b' }),
    ]);

    await expect(service.remove('actor-a', 'remote-a'))
      .resolves
      .toEqual({
        ok: true,
        operationIds: [
          `operation-${AgentCommandKind.RemoteFsRemove}`,
          `operation-${AgentCommandKind.RemoteFsRemove}`,
        ],
      });

    await expect(mountsRepo.findOne({ where: { id: 'remote-a' } })).resolves.toMatchObject({ id: 'remote-a' });
    await expect(assignmentsRepo.count()).resolves.toBe(2);
    expect(operationsService.dispatchAgentCommand).toHaveBeenCalledTimes(2);
  });

  it('remove rejects when the remote FS mount still has data directories', async () => {
    await dataSource.getRepository(DataDirectoryEntity).save(dataSource.getRepository(DataDirectoryEntity).create({
      id: 'dir-a',
      userId: 'user-a',
      sourceKind: 'remote',
      sourceId: 'remote-a',
      name: 'shared',
      serverId: null,
      uid: 1000,
    }));

    await expect(service.remove('actor-a', 'remote-a')).rejects.toThrow(
      'This remote FS mount still has data directories; delete those data directories first',
    );
    expect(operationsService.dispatchAgentCommand).not.toHaveBeenCalled();
  });

  it('unassignServer rejects when the remote FS mount still has data directories', async () => {
    await assignmentsRepo.save(assignmentsRepo.create({
      id: 'assignment-a',
      remoteFsMountId: 'remote-a',
      serverId: 'server-a',
    }));
    await dataSource.getRepository(DataDirectoryEntity).save(dataSource.getRepository(DataDirectoryEntity).create({
      id: 'dir-a',
      userId: 'user-a',
      sourceKind: 'remote',
      sourceId: 'remote-a',
      name: 'shared',
      serverId: null,
      uid: 1000,
    }));

    await expect(service.unassignServer('actor-a', 'remote-a', 'server-a')).rejects.toThrow(
      'Cannot unassign: this remote FS mount still has data directories; delete those data directories first',
    );
    expect(operationsService.dispatchAgentCommand).not.toHaveBeenCalled();
  });
});
