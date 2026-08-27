import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PgSchemaReadiness } from '../persistence-pg/persistence-pg.module.js';
import { RedisDisposableAdapter } from '../runtime/redis-disposable.adapter.js';
import { RuntimeRoleService } from '../runtime/runtime-role.service.js';
import { RuntimeLifecycleService } from './runtime-lifecycle.service.js';

/**
 * Unauthenticated process probes. Liveness deliberately avoids dependencies;
 * readiness verifies authoritative PostgreSQL. Redis is additionally required
 * by split API/Gateway roles because the disposable runtime boundary is used
 * by the console bridge and other ephemeral sessions.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly schemaReadiness: PgSchemaReadiness,
    private readonly redis: RedisDisposableAdapter,
    private readonly runtimeRole: RuntimeRoleService,
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
    if (
      this.runtimeRole.requiresRedisAvailability()
      && !this.redis.isAvailable()
    ) {
      throw new ServiceUnavailableException({
        code: 'REDIS_NOT_READY',
        message: 'Redis is required for disposable runtime state',
      });
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
