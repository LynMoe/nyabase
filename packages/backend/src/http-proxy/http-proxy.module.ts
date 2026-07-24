import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccessModule } from '../access/access.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerSshRouteEntity } from '../entities/container-ssh-route.entity.js';
import { HttpDomainPoolEntity } from '../entities/http-domain-pool.entity.js';
import { HttpProxyBindingEntity } from '../entities/http-proxy-binding.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { AdminHttpProxyController } from './admin-http-proxy.controller.js';
import { HttpProxyController } from './http-proxy.controller.js';
import { HttpProxyGateway } from './http-proxy-gateway.js';
import { HttpProxyService } from './http-proxy.service.js';
import { HttpHostnameReservationEntity } from '../entities/http-hostname-reservation.entity.js';
import { AuditModule } from '../audit/audit.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      HttpDomainPoolEntity,
      HttpProxyBindingEntity,
      ContainerEntity,
      ContainerLifecycleEntity,
      ContainerDesiredSpecEntity,
      ContainerSshRouteEntity,
      UserEntity,
      HttpHostnameReservationEntity,
    ]),
    forwardRef(() => AuthModule),
    forwardRef(() => AccessModule),
    ProxySnapshotNotifierModule,
    AuditModule,
  ],
  providers: [HttpProxyService, HttpProxyGateway],
  controllers: [HttpProxyController, AdminHttpProxyController],
  exports: [HttpProxyService, HttpProxyGateway],
})
export class HttpProxyModule {}
