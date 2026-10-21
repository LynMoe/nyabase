import { Module } from '@nestjs/common';
import { ContainersModule } from '../containers/containers.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { AdminSshProxyController } from './admin-ssh-proxy.controller.js';
import { SshIdentityService } from './ssh-identity.service.js';
import { SshKeyCryptoService } from './ssh-key-crypto.service.js';
import { SshKeygenService } from './ssh-keygen.service.js';
import { SshProxyGateway } from './ssh-proxy-gateway.js';
import { SshProxySnapshotService } from './ssh-proxy-snapshot.service.js';

@Module({
  imports: [ContainersModule, ProxySnapshotNotifierModule],
  providers: [
    SshIdentityService,
    SshKeyCryptoService,
    SshKeygenService,
    SshProxyGateway,
    SshProxySnapshotService,
  ],
  controllers: [AdminSshProxyController],
  exports: [
    SshIdentityService,
    SshProxyGateway,
    SshProxySnapshotService,
    SshKeyCryptoService,
    SshKeygenService,
  ],
})
export class SshModule {}
