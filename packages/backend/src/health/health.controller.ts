import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PgSchemaReadiness } from '../persistence-pg/persistence-pg.module.js';
import { RuntimeLifecycleService } from './runtime-lifecycle.service.js';

/**
 * Unauthenticated process probes. Liveness deliberately avoids dependencies;
 * readiness verifies authoritative PostgreSQL.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly schemaReadiness: PgSchemaReadiness,
    private readonly lifecycle: RuntimeLifecycleService,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' as const };
  }

  @Get('ready')
  async ready() {
    if (!this.lifecycle.isAcceptingTraffic()) {
      throw new ServiceUnavailableException({
        code: 'PROCESS_NOT_READY',
        message: 'Process is starting or draining',
      });
    }
    try {
      await this.schemaReadiness.check();
    } catch {
      throw notReady();
    }
    return { status: 'ok' as const, database: 'ok' as const };
  }
}

function notReady(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'DATABASE_NOT_READY',
    message: 'Database is not ready',
  });
}
