import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { BadRequestException } from '@nestjs/common';
import type { PerformanceMetric, PerformanceRange } from '@nyabase/common';
import { CurrentUser } from '../iam/decorators/current-user.decorator.js';
import type { UserRecord } from '../iam/user-record.js';
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

@Controller('performance')
export class PerformanceController {
  constructor(private readonly performance: PerformanceQueryService) {}

  @Get('usage')
  usage(@CurrentUser() user: UserRecord, @Query() query: Record<string, unknown>) {
    return this.performance.userUsage(user.id, parseQuery(zUsageQuery, query));
  }

  @Get('series')
  series(@CurrentUser() user: UserRecord, @Query() query: Record<string, unknown>) {
    return this.performance.userSeries(user.id, parseQuery(zSeriesQuery, query));
  }
}

export function parseQuery<T extends z.ZodTypeAny>(
  schema: T,
  query: Record<string, unknown>,
): {
  serverId?: string;
  userId?: string;
  containerId?: string;
  metric?: PerformanceMetric;
  metrics?: string;
  spark?: '1';
  range?: PerformanceRange;
} {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) throw new BadRequestException(`${key} is invalid`);
    if (value === undefined || value === '') continue;
    normalized[key] = value;
  }
  const parsed = schema.safeParse(normalized);
  if (!parsed.success) throw new BadRequestException('Invalid performance query');
  return parsed.data;
}
