import { Module } from '@nestjs/common';
import { AgentCredentialVerifier } from './agent-credentials.js';
import { AgentGateway } from './agent-gateway.js';
import { AgentRegistry } from './agent-registry.service.js';
import { AgentIncusClientFactory, INCUS_CLIENT_FACTORY } from './incus-client.factory.js';

@Module({
  providers: [
    AgentRegistry,
    AgentCredentialVerifier,
    AgentGateway,
    AgentIncusClientFactory,
    { provide: INCUS_CLIENT_FACTORY, useExisting: AgentIncusClientFactory },
  ],
  exports: [INCUS_CLIENT_FACTORY, AgentRegistry, AgentGateway],
})
export class IncusModule {}
