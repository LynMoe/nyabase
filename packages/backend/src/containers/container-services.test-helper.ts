import type { Kysely } from 'kysely';
import type { AccessResolverService } from '../iam/access-resolver.service.js';
import type { AuditService } from '../iam/audit.service.js';
import type { GpuClaimsRepository } from '../gpu/gpu-claims.repository.js';
import type { IpPoolsRepository } from '../ip-pools/ip-pools.repository.js';
import type { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import type { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import type { IntentRepository } from '../reconcile/intent.repository.js';
import type { VolumeAttachmentsService } from '../volumes/volume-attachments.service.js';
import type { ConsoleSessionService } from './console-session.service.js';
import type { ContainerControlRepository } from './container-control.repository.js';
import { ContainerControlService } from './container-control.service.js';
import { ContainerCreateService } from './container-create.service.js';
import { ContainerDtoAssembler } from './container-dtos.js';
import type { ContainerSshConvergenceService } from './container-ssh.js';

/** Builds a ContainerControlService with its create/DTO collaborators over the same fakes. */
export function makeContainerControlService(
  database: Kysely<NyabaseDatabase>,
  transactions: PgTransactionManager,
  repository: ContainerControlRepository,
  access: AccessResolverService,
  intents: IntentRepository,
  consoleSessions: ConsoleSessionService,
  audit: AuditService,
  ipPools: IpPoolsRepository,
  config: NyabaseConfigService,
  sshConvergence: ContainerSshConvergenceService,
  volumes: VolumeAttachmentsService,
  gpuClaims: GpuClaimsRepository,
): ContainerControlService {
  return new ContainerControlService(
    transactions,
    repository,
    access,
    intents,
    consoleSessions,
    audit,
    sshConvergence,
    volumes,
    gpuClaims,
    new ContainerDtoAssembler(database, repository, config),
    new ContainerCreateService(repository, access, intents, audit, ipPools, volumes, gpuClaims),
  );
}
