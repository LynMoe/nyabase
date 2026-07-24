import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Unauthenticated process probes. Liveness deliberately avoids dependencies;
 * readiness verifies the live TypeORM connection can execute a read-only query.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  @Get('live')
  live() {
    return { status: 'ok' as const };
  }

  @Get('ready')
  async ready() {
    if (!this.dataSource.isInitialized) {
      throw notReady();
    }
    try {
      await this.dataSource.query('SELECT 1');
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
