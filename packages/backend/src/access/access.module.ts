import { Module, forwardRef } from '@nestjs/common';
import { AccessResolverService } from './access-resolver.service.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { AccessCacheEpochModule } from './access-cache-epoch.module.js';
import { AccessRevocationGuardService } from './access-revocation-guard.service.js';

@Module({
  imports: [
    AccessCacheEpochModule,
    forwardRef(() => AgentGatewayModule),
  ],
  providers: [AccessResolverService, AccessRevocationGuardService],
  exports: [AccessResolverService, AccessRevocationGuardService],
})
export class AccessModule {}
