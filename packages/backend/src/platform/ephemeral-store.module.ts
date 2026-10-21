import { Global, Module } from '@nestjs/common';
import { EphemeralStore } from './ephemeral-store.js';

@Global()
@Module({
  providers: [EphemeralStore],
  exports: [EphemeralStore],
})
export class EphemeralStoreModule {}
