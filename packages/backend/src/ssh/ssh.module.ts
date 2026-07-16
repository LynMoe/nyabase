import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module.js';
import { AccessModule } from '../access/access.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ContainerSshRouteEntity } from '../entities/container-ssh-route.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { SshProxyHostKeyEntity } from '../entities/ssh-proxy-host-key.entity.js';
import { SshPublicKeyEntity } from '../entities/ssh-public-key.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { UserInternalSshKeyEntity } from '../entities/user-internal-ssh-key.entity.js';
import { ContainerSshRouteService } from './container-ssh-route.service.js';
import { AdminSshProxyController } from './admin-ssh-proxy.controller.js';
import { SshIdentityService } from './ssh-identity.service.js';
import { SshKeyCryptoService } from './ssh-key-crypto.service.js';
import { SshKeygenService } from './ssh-keygen.service.js';
import { SshProxyGateway } from './ssh-proxy-gateway.js';
import { SshProxySnapshotService } from './ssh-proxy-snapshot.service.js';
import { ContainerSshConvergenceService } from './container-ssh-convergence.service.js';
import { AgentTasksModule } from '../agent-tasks/agent-tasks.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      SshPublicKeyEntity,
      UserInternalSshKeyEntity,
      SshProxyHostKeyEntity,
      ServerEntity,
      ImageEntity,
      ContainerEntity,
      ContainerLifecycleEntity,
      ContainerSshRouteEntity,
      NetworkAddressClaimEntity,
    ]),
    AuthModule,
    AccessModule,
    AgentTasksModule,
    ProxySnapshotNotifierModule,
    forwardRef(() => AuditModule),
  ],
  providers: [
    SshIdentityService,
    SshKeyCryptoService,
    SshKeygenService,
    SshProxyGateway,
    SshProxySnapshotService,
    ContainerSshRouteService,
    ContainerSshConvergenceService,
  ],
  controllers: [AdminSshProxyController],
  exports: [
    SshIdentityService,
    SshProxyGateway,
    SshProxySnapshotService,
    ContainerSshRouteService,
    ContainerSshConvergenceService,
  ],
})
export class SshModule {}
