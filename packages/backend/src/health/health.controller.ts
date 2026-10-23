import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../iam/decorators.js';
import { PgSchemaReadiness } from '../platform/persistence-pg/persistence-pg.module.js';
import { RuntimeLifecycleService } from './runtime-lifecycle.service.js';

/** How long one database verdict answers every readiness probe. */
export const READINESS_CACHE_MS = 1_000;

/**
 * Unauthenticated process probes. Liveness deliberately avoids dependencies;
 * readiness verifies authoritative PostgreSQL.
 */
@Public()
@Controller('health')
export class HealthController {
  private readonly database = new SharedCheck(
    () => this.schemaReadiness.check(),
    READINESS_CACHE_MS,
  );

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
    if (!(await this.database.run())) throw notReady();
    return { status: 'ok' as const, database: 'ok' as const };
  }
}

/**
 * The readiness check borrows a connection from the shared request pool, and
 * the probe is public. Concurrent probes share one check and its verdict is
 * reused for `ttlMs`, so a probe flood costs at most one pooled connection per
 * interval instead of starving real requests.
 */
export class SharedCheck {
  private inflight: Promise<boolean> | null = null;
  private verdict: { ok: boolean; at: number } | null = null;

  constructor(
    private readonly check: () => Promise<void>,
    private readonly ttlMs: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  run(): Promise<boolean> {
    if (this.verdict && this.now() - this.verdict.at < this.ttlMs) {
      return Promise.resolve(this.verdict.ok);
    }
    this.inflight ??= this.check()
      .then(() => true, () => false)
      .then((ok) => {
        this.verdict = { ok, at: this.now() };
        this.inflight = null;
        return ok;
      });
    return this.inflight;
  }
}

function notReady(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'DATABASE_NOT_READY',
    message: 'Database is not ready',
  });
}
