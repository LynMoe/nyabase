import { Module, forwardRef } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { AdminHttpProxyController } from './admin-http-proxy.controller.js';
import { HttpProxyController } from './http-proxy.controller.js';
import { HttpProxyGateway } from './http-proxy-gateway.js';
import { HttpProxyService } from './http-proxy.service.js';
import { AuditModule } from '../audit/audit.module.js';

@Module({
  imports: [
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
