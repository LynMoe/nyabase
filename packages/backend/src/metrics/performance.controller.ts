import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { BadRequestException } from '@nestjs/common';
import { zListScope, type PerformanceMetric, type PerformanceRange } from '@nyabase/common';
import { CurrentActor } from '../iam/decorators/current-actor.decorator.js';
import type { Actor } from '../iam/actor.js';
import { PerformanceQueryService } from './performance-query.service.js';

const zUsageQuery = z.object({
  scope: zListScope,
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

/** `scope=mine` (default) is the caller's own usage; `scope=all` needs `ViewMetricsAll`. */
@Controller('performance')
export class PerformanceController {
  constructor(private readonly performance: PerformanceQueryService) {}

  @Get('usage')
  usage(@CurrentActor() actor: Actor, @Query() query: Record<string, unknown>) {
    const { scope, ...filters } = parseQuery(zUsageQuery, query);
    return this.performance.usage(actor, filters, scope);
  }

  @Get('series')
  series(@CurrentActor() actor: Actor, @Query() query: Record<string, unknown>) {
    const { scope, ...filters } = parseQuery(zSeriesQuery, query);
    return this.performance.series(actor, filters, scope);
  }
}

function parseQuery<T extends z.ZodTypeAny>(
  schema: T,
  query: Record<string, unknown>,
): {
  scope: 'mine' | 'all';
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
