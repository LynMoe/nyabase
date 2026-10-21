import { Module } from '@nestjs/common';
import { DatabaseIncusClientFactory, INCUS_CLIENT_FACTORY } from './incus-client.factory.js';

@Module({
  providers: [
    DatabaseIncusClientFactory,
    { provide: INCUS_CLIENT_FACTORY, useExisting: DatabaseIncusClientFactory },
  ],
  exports: [INCUS_CLIENT_FACTORY],
})
export class IncusModule {}
