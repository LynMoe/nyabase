import { Module, forwardRef } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { AuditRepository } from './audit.repository.js';
import {
  AUDIT_SNAPSHOT_RESOLVER,
  PgAuditSnapshotResolver,
} from './audit-snapshot.resolver.js';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    forwardRef(() => AccessModule),
  ],
  controllers: [AuditController],
  providers: [
    AuditRepository,
    PgAuditSnapshotResolver,
    {
      provide: AUDIT_SNAPSHOT_RESOLVER,
      useExisting: PgAuditSnapshotResolver,
    },
    AuditService,
  ],
  exports: [AuditService],
})
export class AuditModule {}
