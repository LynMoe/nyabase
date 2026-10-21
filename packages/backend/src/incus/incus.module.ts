import { Module } from '@nestjs/common';
import { DatabaseIncusClientFactory, INCUS_CLIENT_FACTORY } from './incus-client.factory.js';
import { IncusClientIdentityService } from './incus-client-identity.service.js';

@Module({
  providers: [
    IncusClientIdentityService,
    DatabaseIncusClientFactory,
    { provide: INCUS_CLIENT_FACTORY, useExisting: DatabaseIncusClientFactory },
  ],
  exports: [INCUS_CLIENT_FACTORY, IncusClientIdentityService],
})
export class IncusModule {}
