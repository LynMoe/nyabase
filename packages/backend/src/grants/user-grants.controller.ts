import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Put,
} from '@nestjs/common';
import {
  zPatchServerGrantRequest,
  zPutServerGrantRequest,
  zPutSharedBackendGrantRequest,
  zPutStoragePoolGrantRequest,
  type EffectiveAccessDto,
  Role,
} from '@nyabase/common';
import { RequireRole, CurrentActor } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import { GrantsService } from './grants.service.js';

@Controller('users/:userId')
export class UserGrantsController {
  constructor(
    private readonly grants: GrantsService,
    private readonly access: AccessResolverService,
  ) {}

  @Get('server-grants')
  @RequireRole(Role.UserAdmin)
  listServerGrants(@Param('userId') userId: string) {
    return this.grants.listServerGrants(userId);
  }

  @Put('server-grants/:serverId')
  @RequireRole(Role.UserAdmin)
  putServerGrant(
    @Param('userId') userId: string,
    @Param('serverId') serverId: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.putServerGrant(actor, userId, serverId, zPutServerGrantRequest.parse(body));
  }

  @Patch('server-grants/:serverId')
  @RequireRole(Role.UserAdmin)
  patchServerGrant(
    @Param('userId') userId: string,
    @Param('serverId') serverId: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.patchServerGrant(actor, userId, serverId, zPatchServerGrantRequest.parse(body));
  }

  @Delete('server-grants/:serverId')
  @RequireRole(Role.UserAdmin)
  deleteServerGrant(
    @Param('userId') userId: string,
    @Param('serverId') serverId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.deleteServerGrant(actor, userId, serverId);
  }

  @Put('storage-pool-grants/:poolId')
  @RequireRole(Role.UserAdmin)
  putStoragePoolGrant(
    @Param('userId') userId: string,
    @Param('poolId') poolId: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.putStoragePoolGrant(
      actor,
      userId,
      poolId,
      zPutStoragePoolGrantRequest.parse(body).limitBytes,
    );
  }

  @Delete('storage-pool-grants/:poolId')
  @RequireRole(Role.UserAdmin)
  deleteStoragePoolGrant(
    @Param('userId') userId: string,
    @Param('poolId') poolId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.deleteStoragePoolGrant(actor, userId, poolId);
  }

  @Get('shared-backend-grants')
  @RequireRole(Role.UserAdmin)
  listSharedBackendGrants(@Param('userId') userId: string) {
    return this.grants.listSharedBackendGrants(userId);
  }

  @Put('shared-backend-grants/:backendId')
  @RequireRole(Role.UserAdmin)
  putSharedBackendGrant(
    @Param('userId') userId: string,
    @Param('backendId') backendId: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.putSharedBackendGrant(
      actor,
      userId,
      backendId,
      zPutSharedBackendGrantRequest.parse(body),
    );
  }

  @Delete('shared-backend-grants/:backendId')
  @RequireRole(Role.UserAdmin)
  deleteSharedBackendGrant(
    @Param('userId') userId: string,
    @Param('backendId') backendId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.deleteSharedBackendGrant(actor, userId, backendId);
  }

  @Get('effective-access')
  @RequireRole(Role.UserAdmin)
  async effectiveAccess(@Param('userId') userId: string): Promise<EffectiveAccessDto> {
    await this.grants.assertUserExists(userId);
    return {
      servers: await this.access.getEffectiveAccess(userId),
      sharedBackends: await this.access.getEffectiveSharedAccess(userId),
    };
  }
}
