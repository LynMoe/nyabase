import { Module } from '@nestjs/common';
import { ContainersModule } from '../containers/containers.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { SshHostCaModule } from '../ssh-host-ca/ssh-host-ca.module.js';
import { AdminSshProxyController } from './admin-ssh-proxy.controller.js';
import { AdminSshProxyLinesController } from './admin-ssh-proxy-lines.controller.js';
import { SshIdentityService } from './ssh-identity.service.js';
import { SshKeygenService } from './ssh-keygen.service.js';
import { SshProxyGateway } from './ssh-proxy-gateway.js';
import { SshProxySnapshotService } from './ssh-proxy-snapshot.service.js';
import { SshProxyLinesService } from './ssh-proxy-lines.service.js';
import { SshHistoryRepository } from './ssh-history.repository.js';
import { SshHistoryService } from './ssh-history.service.js';
import { SshSessionsService } from './ssh-sessions.service.js';
import { SshSessionsController } from './ssh-sessions.controller.js';

@Module({
  imports: [ContainersModule, ProxySnapshotNotifierModule, SshHostCaModule],
  providers: [
    SshIdentityService,
    SshKeygenService,
    SshProxyGateway,
    SshProxySnapshotService,
    SshProxyLinesService,
    SshHistoryRepository,
    SshHistoryService,
    SshSessionsService,
  ],
  controllers: [AdminSshProxyController, AdminSshProxyLinesController, SshSessionsController],
  exports: [
    SshIdentityService,
    SshProxyGateway,
    SshProxySnapshotService,
    SshProxyLinesService,
    SshKeygenService,
  ],
})
export class SshModule {}
