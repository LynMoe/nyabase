import { Module } from '@nestjs/common';
import { ContainerSshRouteService } from './container-ssh-route.service.js';
import { AdminSshProxyController } from './admin-ssh-proxy.controller.js';
import { SshIdentityService } from './ssh-identity.service.js';
import { SshKeyCryptoService } from './ssh-key-crypto.service.js';
import { SshKeygenService } from './ssh-keygen.service.js';
import { SshProxyGateway } from './ssh-proxy-gateway.js';
import { SshProxySnapshotService } from './ssh-proxy-snapshot.service.js';
import { ContainerControlRepository } from '../containers/container-control.repository.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { ContainerSshConvergenceService } from './container-ssh-convergence.service.js';
import { RuntimeModule } from '../runtime/runtime.module.js';

@Module({
  imports: [
    ProxySnapshotNotifierModule,
    RuntimeModule,
  ],
  providers: [
    SshIdentityService,
    SshKeyCryptoService,
    SshKeygenService,
    SshProxyGateway,
    SshProxySnapshotService,
    ContainerSshRouteService,
    ContainerSshConvergenceService,
    ContainerControlRepository,
  ],
  controllers: [AdminSshProxyController],
  exports: [
    SshIdentityService,
    SshProxyGateway,
    SshProxySnapshotService,
    ContainerSshRouteService,
    SshKeyCryptoService,
    SshKeygenService,
    ContainerSshConvergenceService,
  ],
})
export class SshModule {}
