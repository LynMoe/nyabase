import { Module } from '@nestjs/common';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import {
  HttpProxyController,
  HttpProxyDomainPoolsController,
  HttpProxyStatusController,
} from './http-proxy.controller.js';
import { HttpProxyGateway } from './http-proxy-gateway.js';
import { HttpDomainPoolsService } from './http-domain-pools.service.js';
import { HttpProxyBindingsService } from './http-proxy-bindings.service.js';
import { HttpProxySnapshotService } from './http-proxy-snapshot.service.js';
import { HttpProxyTrafficService } from './http-proxy-traffic.service.js';

@Module({
  imports: [
    ProxySnapshotNotifierModule,
  ],
  providers: [
    HttpProxyBindingsService,
    HttpDomainPoolsService,
    HttpProxySnapshotService,
    HttpProxyTrafficService,
    HttpProxyGateway,
  ],
  controllers: [HttpProxyController, HttpProxyDomainPoolsController, HttpProxyStatusController],
  exports: [HttpProxyGateway],
})
export class HttpProxyModule {}
