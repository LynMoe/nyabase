import { Controller, Param, Post } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { RequireCaps } from '../iam/decorators/require-caps.decorator.js';
import { CurrentActor } from '../iam/decorators/current-actor.decorator.js';
import type { Actor } from '../iam/actor.js';
import { GroupsService } from '../groups/groups.service.js';
import { UserServerResourcePurgeService } from './user-server-resource-purge.service.js';

@Controller('users/:userId')
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
    @CurrentActor() actor: Actor,
  ) {
    await this.groupsService.assertUserScopeExists(userId);
    return this.purgeResources.purge(actor, userId, serverId);
  }
}
