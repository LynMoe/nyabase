import { Module } from '@nestjs/common';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import {
  HttpProxyController,
  HttpProxyDomainPoolsController,
  HttpProxyStatusController,
} from './http-proxy.controller.js';
import { HttpProxyGateway } from './http-proxy-gateway.js';
import { HttpProxyService } from './http-proxy.service.js';

@Module({
  imports: [
    ProxySnapshotNotifierModule,
  ],
  providers: [HttpProxyService, HttpProxyGateway],
  controllers: [HttpProxyController, HttpProxyDomainPoolsController, HttpProxyStatusController],
  exports: [HttpProxyService, HttpProxyGateway],
})
export class HttpProxyModule {}
