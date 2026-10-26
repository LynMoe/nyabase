import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  onlyWithScopeAll,
  zListScope,
  type PerformanceMetric,
  type PerformanceRange,
} from '@nyabase/common';
import { CurrentActor } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { PerformanceQueryService } from './performance-query.service.js';

const zUsageFields = z.object({
  scope: zListScope,
  serverId: z.string().optional(),
  /** Another person's usage: an administrator filter, `scope=all` only. */
  userId: z.string().optional(),
  containerId: z.string().optional(),
  spark: z.literal('1').optional(),
}).strict();

export const zUsageQuery = zUsageFields.superRefine(onlyWithScopeAll('userId'));

export const zSeriesQuery = zUsageFields.extend({
  metric: z.enum(['cpu', 'memory', 'disk', 'gpu', 'network']).optional(),
  metrics: z.string().optional(),
  range: z.enum(['15m', '1h', '6h', '24h']).optional(),
}).strict().superRefine(onlyWithScopeAll('userId'));

/**
 * `scope=mine` (default) is the caller's own usage; `scope=all` needs the
 * operator role and is the only scope that takes `userId`.
 */
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

type PerformanceQuery = {
  scope: 'mine' | 'all';
  serverId?: string;
  userId?: string;
  containerId?: string;
  metric?: PerformanceMetric;
  metrics?: string;
  spark?: '1';
  range?: PerformanceRange;
};

function parseQuery(
  schema: z.ZodType<PerformanceQuery>,
  query: Record<string, unknown>,
): PerformanceQuery {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) throw new BadRequestException(`${key} is invalid`);
    if (value === undefined || value === '') continue;
    normalized[key] = value;
  }
  // A ZodError becomes 400 INVALID_INPUT naming the field (ZodExceptionFilter).
  return schema.parse(normalized);
}
