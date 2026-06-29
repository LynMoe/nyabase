import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module.js';
import { AccessModule } from '../access/access.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerSshRouteEntity } from '../entities/container-ssh-route.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { SshProxyHostKeyEntity } from '../entities/ssh-proxy-host-key.entity.js';
import { SshProxyTokenEntity } from '../entities/ssh-proxy-token.entity.js';
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

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      SshPublicKeyEntity,
      UserInternalSshKeyEntity,
      SshProxyHostKeyEntity,
      SshProxyTokenEntity,
      ServerEntity,
      ImageEntity,
      ContainerEntity,
      ContainerSshRouteEntity,
    ]),
    AuthModule,
    AccessModule,
    forwardRef(() => AuditModule),
  ],
  providers: [
    SshIdentityService,
    SshKeyCryptoService,
    SshKeygenService,
    SshProxyGateway,
    SshProxySnapshotService,
    ContainerSshRouteService,
  ],
  controllers: [AdminSshProxyController],
  exports: [
    SshIdentityService,
    SshProxyGateway,
    SshProxySnapshotService,
    ContainerSshRouteService,
  ],
})
export class SshModule {}
