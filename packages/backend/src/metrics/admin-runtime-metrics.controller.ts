import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import type { Pool } from 'pg';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PG_POOL } from '../persistence-pg/tokens.js';
import { MetricsWriter } from './metrics-writer.js';

export interface RuntimeDependencyMetrics {
  postgres: {
    total: number;
    idle: number;
    waiting: number;
    max: number;
  };
  telemetry: {
    queuedBatches: number;
    queuedPoints: number;
    queuedBytes: number;
    droppedBatches: number;
    inFlightFlushes: number;
    lastFlushAt: number | null;
    degraded: boolean;
  };
}

/**
 * Authenticated, low-cardinality runtime aggregates. Deliberately excludes
 * connection strings, server/user IDs, SQL text, and raw errors.
 */
@Controller('admin/metrics')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ViewMetricsAll)
export class AdminRuntimeMetricsController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly metricsWriter: MetricsWriter,
  ) {}

  @Get('runtime')
  runtime(): RuntimeDependencyMetrics {
    const telemetry = this.metricsWriter.getStats();
    return {
      postgres: {
        total: this.pool.totalCount,
        idle: this.pool.idleCount,
        waiting: this.pool.waitingCount,
        max: this.pool.options.max,
      },
      telemetry: {
        queuedBatches: telemetry.queued,
        queuedPoints: telemetry.queuedPoints,
        queuedBytes: telemetry.queuedBytes,
        droppedBatches: telemetry.dropped,
        inFlightFlushes: telemetry.inFlight,
        lastFlushAt: telemetry.lastFlushAt,
        degraded: telemetry.lastError !== null,
      },
    };
  }
}
