import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Capability } from '@nyabase/common';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { UserRecord } from '../domain/domain-records.js';
import { parseQuery } from './performance.controller.js';
import { PerformanceQueryService } from './performance-query.service.js';

const zUsageQuery = z.object({
  serverId: z.string().optional(),
  userId: z.string().optional(),
  containerId: z.string().optional(),
  spark: z.literal('1').optional(),
}).strict();

const zSeriesQuery = zUsageQuery.extend({
  metric: z.enum(['cpu', 'memory', 'disk', 'gpu', 'network']).optional(),
  metrics: z.string().optional(),
  range: z.enum(['15m', '1h', '6h', '24h']).optional(),
});

@Controller('admin/performance')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ViewMetricsAll)
export class AdminPerformanceController {
  constructor(private readonly performance: PerformanceQueryService) {}

  @Get('usage')
  usage(@CurrentUser() user: UserRecord, @Query() query: Record<string, unknown>) {
    return this.performance.adminUsage(user.id, parseQuery(zUsageQuery, query), true);
  }

  @Get('series')
  series(@CurrentUser() user: UserRecord, @Query() query: Record<string, unknown>) {
    return this.performance.adminSeries(user.id, parseQuery(zSeriesQuery, query), true);
  }
}
