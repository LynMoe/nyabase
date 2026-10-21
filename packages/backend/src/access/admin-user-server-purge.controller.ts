import { Controller, Param, Post } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { RequireCaps, CurrentActor } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { GrantsService } from '../groups/grants.service.js';
import { UserServerResourcePurgeService } from './user-server-resource-purge.service.js';

@Controller('users/:userId')
export class AdminUserServerPurgeController {
  constructor(
    private readonly grants: GrantsService,
    private readonly purgeResources: UserServerResourcePurgeService,
  ) {}

  @Post('servers/:serverId/purge-resources')
  @RequireCaps(Capability.ManageGrants, Capability.ManageContainersAny)
  async purgeUserServerResources(
    @Param('userId') userId: string,
    @Param('serverId') serverId: string,
    @CurrentActor() actor: Actor,
  ) {
    await this.grants.assertSubjectExists({ kind: 'user', id: userId });
    return this.purgeResources.purge(actor, userId, serverId);
  }
}
