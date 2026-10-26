import { Module } from '@nestjs/common';
import { IncusModule } from '../incus/incus.module.js';
import { AdminFirewallRulesController } from './firewall.controller.js';
import { FirewallRepository } from './firewall.repository.js';
import { FirewallService } from './firewall.service.js';
import { FirewallSyncService } from './firewall-sync.service.js';

/**
 * Guest egress firewall rules and their push to each server's agent. Depends
 * only on platform / iam / incus; servers read the sync state through
 * FirewallSyncService (servers -> firewall, never the reverse).
 */
@Module({
  imports: [IncusModule],
  providers: [FirewallRepository, FirewallService, FirewallSyncService],
  controllers: [AdminFirewallRulesController],
  exports: [FirewallSyncService],
})
export class FirewallModule {}
