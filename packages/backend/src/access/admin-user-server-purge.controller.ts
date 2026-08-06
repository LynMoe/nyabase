import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import type { UserRecord } from '../domain/domain-records.js';
import { GroupsService } from '../groups/groups.service.js';
import { UserServerResourcePurgeService } from './user-server-resource-purge.service.js';

@Controller('admin/users/:userId')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AdminUserServerPurgeController {
  constructor(
    private readonly groupsService: GroupsService,
    private readonly purgeResources: UserServerResourcePurgeService,
  ) {}

  @Post('servers/:serverId/purge-resources')
  @RequireCaps(Capability.ManageGrants, Capability.ManageContainersAny)
  async purgeUserServerResources(
    @Param('userId') userId: string,
    @Param('serverId') serverId: string,
    @CurrentUser() actor: UserRecord,
  ) {
    await this.groupsService.assertUserScopeExists(userId);
    return this.purgeResources.purge(userId, serverId, actor.id, 'admin');
  }
}
