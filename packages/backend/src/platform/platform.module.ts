import { Global, Module } from '@nestjs/common';
import { NyabaseConfigService } from './config/nyabase-config.service.js';
import { EphemeralStore } from './ephemeral-store.js';
import { MonotonicClock } from './monotonic-clock.js';
import { PgPersistenceModule } from './persistence-pg/persistence-pg.module.js';
import { SshKeyCryptoService } from './ssh-key-crypto.service.js';

/**
 * Process-wide foundations: configuration, PostgreSQL, the in-process
 * ephemeral store, the monotonic clock and at-rest key encryption. Every other module may rely on
 * these without importing this module.
 */
@Global()
@Module({
  imports: [PgPersistenceModule],
  providers: [NyabaseConfigService, EphemeralStore, MonotonicClock, SshKeyCryptoService],
  exports: [PgPersistenceModule, NyabaseConfigService, EphemeralStore, MonotonicClock, SshKeyCryptoService],
})
export class PlatformModule {}
