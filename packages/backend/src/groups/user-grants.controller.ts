import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
} from '@nestjs/common';
import {
  Capability,
  zPutServerGrantRequest,
  zPutSharedBackendGrantRequest,
  zPutStoragePoolGrantRequest,
  type EffectiveAccessDto,
} from '@nyabase/common';
import { RequireCaps } from '../iam/decorators/require-caps.decorator.js';
import { CurrentUser } from '../iam/decorators/current-user.decorator.js';
import type { UserRecord } from '../iam/user-record.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import { GroupsService } from './groups.service.js';

@Controller('users/:userId')
export class UserGrantsController {
  constructor(
    private readonly groups: GroupsService,
    private readonly access: AccessResolverService,
  ) {}

  @Get('server-grants')
  @RequireCaps(Capability.ManageGrants)
  listServerGrants(@Param('userId') userId: string) {
    return this.groups.listUserServerGrants(userId);
  }

  @Put('server-grants/:serverId')
  @RequireCaps(Capability.ManageGrants)
  upsertServerGrant(
    @Param('userId') userId: string,
    @Param('serverId') serverId: string,
    @Body() body: unknown,
    @CurrentUser() actor: UserRecord,
  ) {
    return this.groups.upsertUserServerGrant(
      userId,
      serverId,
      zPutServerGrantRequest.parse(body),
      actor.id,
    );
  }

  @Delete('server-grants/:serverId')
  @RequireCaps(Capability.ManageGrants)
  deleteServerGrant(@Param('userId') userId: string, @Param('serverId') serverId: string, @CurrentUser() actor: UserRecord) {
    return this.groups.deleteUserServerGrant(userId, serverId, actor.id);
  }

  @Get('storage-pool-grants')
  @RequireCaps(Capability.ManageGrants)
  listStoragePoolGrants(@Param('userId') userId: string) {
    return this.groups.listUserStoragePoolGrants(userId);
  }

  @Put('storage-pool-grants/:poolId')
  @RequireCaps(Capability.ManageGrants)
  upsertStoragePoolGrant(
    @Param('userId') userId: string,
    @Param('poolId') poolId: string,
    @Body() body: unknown,
    @CurrentUser() actor: UserRecord,
  ) {
    return this.groups.upsertUserStoragePoolGrant(
      userId,
      poolId,
      zPutStoragePoolGrantRequest.parse(body).expiresAt,
      actor.id,
    );
  }

  @Delete('storage-pool-grants/:poolId')
  @RequireCaps(Capability.ManageGrants)
  deleteStoragePoolGrant(@Param('userId') userId: string, @Param('poolId') poolId: string, @CurrentUser() actor: UserRecord) {
    return this.groups.deleteUserStoragePoolGrant(userId, poolId, actor.id);
  }

  @Get('shared-backend-grants')
  @RequireCaps(Capability.ManageGrants)
  listSharedBackendGrants(@Param('userId') userId: string) {
    return this.groups.listUserSharedBackendGrants(userId);
  }

  @Put('shared-backend-grants/:backendId')
  @RequireCaps(Capability.ManageGrants)
  upsertSharedBackendGrant(
    @Param('userId') userId: string,
    @Param('backendId') backendId: string,
    @Body() body: unknown,
    @CurrentUser() actor: UserRecord,
  ) {
    return this.groups.upsertUserSharedBackendGrant(
      userId,
      backendId,
      zPutSharedBackendGrantRequest.parse(body),
      actor.id,
    );
  }

  @Delete('shared-backend-grants/:backendId')
  @RequireCaps(Capability.ManageGrants)
  deleteSharedBackendGrant(@Param('userId') userId: string, @Param('backendId') backendId: string, @CurrentUser() actor: UserRecord) {
    return this.groups.deleteUserSharedBackendGrant(userId, backendId, actor.id);
  }

  @Get('effective-access')
  @RequireCaps(Capability.ManageGrants)
  async effectiveAccess(@Param('userId') userId: string): Promise<EffectiveAccessDto> {
    await this.groups.assertUserScopeExists(userId);
    return {
      servers: await this.access.getEffectiveAccess(userId),
      sharedBackends: await this.access.getEffectiveSharedAccess(userId),
    };
  }
}
