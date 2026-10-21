import { Global, Module } from '@nestjs/common';
import { NyabaseConfigService } from './config/nyabase-config.service.js';
import { EphemeralStore } from './ephemeral-store.js';
import { MonotonicClock } from './monotonic-clock.js';
import { PgPersistenceModule } from './persistence-pg/persistence-pg.module.js';

/**
 * Process-wide foundations: configuration, PostgreSQL, the in-process
 * ephemeral store and the monotonic clock. Every other module may rely on
 * these without importing this module.
 */
@Global()
@Module({
  imports: [PgPersistenceModule],
  providers: [NyabaseConfigService, EphemeralStore, MonotonicClock],
  exports: [PgPersistenceModule, NyabaseConfigService, EphemeralStore, MonotonicClock],
})
export class PlatformModule {}
