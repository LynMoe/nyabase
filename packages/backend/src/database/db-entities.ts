import { UserEntity } from '../entities/user.entity.js';
import { RefreshTokenEntity } from '../entities/refresh-token.entity.js';
import { ApiTokenEntity } from '../entities/api-token.entity.js';
import { SshPublicKeyEntity } from '../entities/ssh-public-key.entity.js';
import { UserInternalSshKeyEntity } from '../entities/user-internal-ssh-key.entity.js';
import { SshProxyHostKeyEntity } from '../entities/ssh-proxy-host-key.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { AuditLogEntity } from '../entities/audit-log.entity.js';
import { GroupEntity } from '../entities/group.entity.js';
import { GroupMemberEntity } from '../entities/group-member.entity.js';
import { ServerGrantEntity } from '../entities/server-grant.entity.js';
import { ImageGrantEntity } from '../entities/image-grant.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { GpuAllocationEntity } from '../entities/gpu-allocation.entity.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { ContainerSshRouteEntity } from '../entities/container-ssh-route.entity.js';
import { HttpDomainPoolEntity } from '../entities/http-domain-pool.entity.js';
import { HttpProxyBindingEntity } from '../entities/http-proxy-binding.entity.js';
import { HttpHostnameReservationEntity } from '../entities/http-hostname-reservation.entity.js';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';

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
  UserInternalSshKeyEntity,
  SshProxyHostKeyEntity,
  ServerEntity,
  ImageEntity,
  AuditLogEntity,
  GroupEntity,
  GroupMemberEntity,
  ServerGrantEntity,
  ImageGrantEntity,
  RemoteFsMountEntity,
  MountSourceGrantEntity,
  RemoteFsServerAssignmentEntity,
  ContainerMountEntity,
  DataDirectoryEntity,
  ContainerEntity,
  ContainerDesiredSpecEntity,
  ContainerLifecycleEntity,
  GpuAllocationEntity,
  AgentTaskEntity,
  ResourceLockEntity,
  QuotaDesiredEntity,
  ContainerSshRouteEntity,
  HttpDomainPoolEntity,
  HttpProxyBindingEntity,
  HttpHostnameReservationEntity,
  NetworkAddressClaimEntity,
];
