import { Controller, Param, Post } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { RequireCaps } from '../iam/decorators/require-caps.decorator.js';
import { CurrentUser } from '../iam/decorators/current-user.decorator.js';
import type { UserRecord } from '../iam/user-record.js';
import { GroupsService } from '../groups/groups.service.js';
import { UserServerResourcePurgeService } from './user-server-resource-purge.service.js';

@Controller('admin/users/:userId')
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
