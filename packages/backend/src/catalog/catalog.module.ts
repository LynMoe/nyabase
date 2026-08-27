import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminCatalogController } from './admin-catalog.controller.js';
import { AccessModule } from '../access/access.module.js';
import { CatalogPersistence } from './catalog.persistence.js';

@Module({
  imports: [
    AuthModule,
    // CapabilitiesGuard resolves current durable authority through this
    // provider; importing AuthModule alone does not re-export its dependency.
    AccessModule,
  ],
  providers: [CatalogPersistence],
  controllers: [AdminCatalogController],
})
export class CatalogModule {}
