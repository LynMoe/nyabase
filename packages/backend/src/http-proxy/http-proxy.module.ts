import { Module } from '@nestjs/common';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { AdminHttpProxyController } from './admin-http-proxy.controller.js';
import { HttpProxyController, HttpProxyDomainPoolsController } from './http-proxy.controller.js';
import { HttpProxyGateway } from './http-proxy-gateway.js';
import { HttpProxyService } from './http-proxy.service.js';

@Module({
  imports: [
    ProxySnapshotNotifierModule,
  ],
  providers: [HttpProxyService, HttpProxyGateway],
  controllers: [HttpProxyController, HttpProxyDomainPoolsController, AdminHttpProxyController],
  exports: [HttpProxyService, HttpProxyGateway],
})
export class HttpProxyModule {}
