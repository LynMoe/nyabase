import { UserEntity } from '../entities/user.entity.js';
import { RefreshTokenEntity } from '../entities/refresh-token.entity.js';
import { ApiTokenEntity } from '../entities/api-token.entity.js';
import { SshPublicKeyEntity } from '../entities/ssh-public-key.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { AuditLogEntity } from '../entities/audit-log.entity.js';
import { GroupEntity } from '../entities/group.entity.js';
import { GroupMemberEntity } from '../entities/group-member.entity.js';
import { ServerGrantEntity } from '../entities/server-grant.entity.js';
import { ImageGrantEntity } from '../entities/image-grant.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { RuntimeContainerEntity } from '../entities/runtime-container.entity.js';
import { RuntimeContainerStatEntity } from '../entities/runtime-container-stat.entity.js';
import { RuntimeGpuInventoryEntity } from '../entities/runtime-gpu-inventory.entity.js';
import { GpuAllocationEntity } from '../entities/gpu-allocation.entity.js';
import { RuntimeOrphanEntity } from '../entities/runtime-orphan.entity.js';
import { ContainerRuntimeObservationEntity } from '../entities/container-runtime-observation.entity.js';
import { ContainerMountRuntimeEntity } from '../entities/container-mount-runtime.entity.js';
import { OperationEntity } from '../entities/operation.entity.js';
import { OperationStepEntity } from '../entities/operation-step.entity.js';
import { AgentCommandOutboxEntity } from '../entities/agent-command-outbox.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import { ReconcileTaskEntity } from '../entities/reconcile-task.entity.js';
import { DataDirRuntimeObservationEntity } from '../entities/data-dir-runtime-observation.entity.js';
import { RemoteFsRuntimeObservationEntity } from '../entities/remote-fs-runtime-observation.entity.js';
import { DataDiskRuntimeObservationEntity } from '../entities/data-disk-runtime-observation.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { QuotaRuntimeObservationEntity } from '../entities/quota-runtime-observation.entity.js';
import { DockerDaemonRuntimeObservationEntity } from '../entities/docker-daemon-runtime-observation.entity.js';

/**
 * Single source of truth for all TypeORM entities.
 * Both DatabaseModule (runtime) and AppDataSource (CLI migrations) must use this list
 * so that adding a new entity never requires editing two places.
 */
export const DB_ENTITIES = [
  UserEntity,
  RefreshTokenEntity,
  ApiTokenEntity,
  SshPublicKeyEntity,
  ServerEntity,
  ImageEntity,
  AuditLogEntity,
  GroupEntity,
  GroupMemberEntity,
  ServerGrantEntity,
  ImageGrantEntity,
  DataDiskEntity,
  RemoteFsMountEntity,
  MountSourceGrantEntity,
  RemoteFsServerAssignmentEntity,
  ContainerMountEntity,
  DataDirectoryEntity,
  ContainerEntity,
  ContainerDesiredSpecEntity,
  ContainerLifecycleEntity,
  RuntimeContainerEntity,
  RuntimeContainerStatEntity,
  RuntimeGpuInventoryEntity,
  GpuAllocationEntity,
  RuntimeOrphanEntity,
  ContainerRuntimeObservationEntity,
  ContainerMountRuntimeEntity,
  OperationEntity,
  OperationStepEntity,
  AgentCommandOutboxEntity,
  ResourceLockEntity,
  ReconcileTaskEntity,
  DataDirRuntimeObservationEntity,
  RemoteFsRuntimeObservationEntity,
  DataDiskRuntimeObservationEntity,
  QuotaDesiredEntity,
  QuotaRuntimeObservationEntity,
  DockerDaemonRuntimeObservationEntity,
];
