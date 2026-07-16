import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { AgentTasksService } from './agent-tasks.service.js';

@Controller('admin/agent-tasks')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageContainersAny)
export class AdminAgentTasksController {
  constructor(private tasks: AgentTasksService) {}

  @Get()
  list(
    @Query('resourceType') resourceType?: string,
    @Query('resourceId') resourceId?: string,
    @Query('serverId') serverId?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    return this.tasks.listForAdmin({
      resourceType,
      resourceId,
      serverId,
      limit: Number.isSafeInteger(parsedLimit) ? parsedLimit : undefined,
    });
  }

  @Get(':taskId')
  get(@Param('taskId') taskId: string) {
    return this.tasks.getForAdmin(taskId);
  }
}
