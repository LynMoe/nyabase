import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccessModule } from '../access/access.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerSshRouteEntity } from '../entities/container-ssh-route.entity.js';
import { HttpDomainPoolEntity } from '../entities/http-domain-pool.entity.js';
import { HttpProxyBindingEntity } from '../entities/http-proxy-binding.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { AdminHttpProxyController } from './admin-http-proxy.controller.js';
import { HttpProxyController } from './http-proxy.controller.js';
import { HttpProxyGateway } from './http-proxy-gateway.js';
import { HttpProxyService } from './http-proxy.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      HttpDomainPoolEntity,
      HttpProxyBindingEntity,
      ContainerEntity,
      ContainerSshRouteEntity,
      UserEntity,
    ]),
    AuthModule,
    AccessModule,
    forwardRef(() => AgentGatewayModule),
  ],
  providers: [HttpProxyService, HttpProxyGateway],
  controllers: [HttpProxyController, AdminHttpProxyController],
  exports: [HttpProxyService, HttpProxyGateway],
})
export class HttpProxyModule {}
