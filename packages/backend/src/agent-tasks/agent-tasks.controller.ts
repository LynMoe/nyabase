import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { UserRecord } from '../domain/domain-records.js';
import { AgentTasksService } from './agent-tasks.service.js';

@Controller('agent-tasks')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AgentTasksController {
  constructor(private tasks: AgentTasksService) {}

  @Get()
  list(
    @CurrentUser() user: UserRecord,
    @Query('resourceType') resourceType?: string,
    @Query('resourceId') resourceId?: string,
    @Query('serverId') serverId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.tasks.listForUser(user.id, {
      resourceType,
      resourceId,
      serverId,
      limit: parseLimit(limit),
    });
  }

  @Get(':taskId')
  get(@Param('taskId') taskId: string, @CurrentUser() user: UserRecord) {
    return this.tasks.getForUser(user.id, taskId);
  }
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
