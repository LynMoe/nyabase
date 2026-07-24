import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequireAnyCaps } from '../auth/decorators/require-caps.decorator.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { UserEntity } from '../entities/user.entity.js';
import { AgentTasksService } from './agent-tasks.service.js';

@Controller('admin/agent-tasks')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireAnyCaps(
  Capability.ManageContainersAny,
  Capability.ManageServers,
  Capability.ManageImages,
  Capability.ManageGrants,
)
export class AdminAgentTasksController {
  constructor(
    private tasks: AgentTasksService,
    private accessResolver: AccessResolverService,
  ) {}

  @Get()
  async list(
    @CurrentUser() actor: UserEntity,
    @Query('resourceType') resourceType?: string,
    @Query('resourceId') resourceId?: string,
    @Query('serverId') serverId?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    const capabilities = await this.accessResolver.userCapabilitiesCurrent(actor.id);
    return this.tasks.listForAdmin(capabilities, {
      resourceType,
      resourceId,
      serverId,
      limit: Number.isSafeInteger(parsedLimit) ? parsedLimit : undefined,
    });
  }

  @Get(':taskId')
  async get(@CurrentUser() actor: UserEntity, @Param('taskId') taskId: string) {
    const capabilities = await this.accessResolver.userCapabilitiesCurrent(actor.id);
    return this.tasks.getForAdmin(taskId, capabilities);
  }
}
