import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  zPatchServerGrantRequest,
  zPutServerGrantRequest,
  zCreateDataDiskGrantRequest,
  zPatchDataDiskGrantRequest,
  zPutSharedBackendGrantRequest,
  type EffectiveAccessDto,
  Role,
} from '@nyabase/common';
import { RequireRole, CurrentActor } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import { DataDiskGrantsService } from './data-disk-grants.service.js';
import { GrantsService } from './grants.service.js';

@Controller('users/:userId')
export class UserGrantsController {
  constructor(
    private readonly grants: GrantsService,
    private readonly dataDisks: DataDiskGrantsService,
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

  @Get('data-disk-grants')
  @RequireRole(Role.UserAdmin)
  listDataDiskGrants(@Param('userId') userId: string) {
    return this.dataDisks.list(userId);
  }

  @Post('data-disk-grants')
  @RequireRole(Role.UserAdmin)
  createDataDiskGrant(
    @Param('userId') userId: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return this.dataDisks.create(actor, userId, zCreateDataDiskGrantRequest.parse(body));
  }

  @Patch('data-disk-grants/:grantId')
  @RequireRole(Role.UserAdmin)
  patchDataDiskGrant(
    @Param('userId') userId: string,
    @Param('grantId') grantId: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return this.dataDisks.patch(actor, userId, grantId, zPatchDataDiskGrantRequest.parse(body));
  }

  @Delete('data-disk-grants/:grantId')
  @RequireRole(Role.UserAdmin)
  deleteDataDiskGrant(
    @Param('userId') userId: string,
    @Param('grantId') grantId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.dataDisks.delete(actor, userId, grantId);
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
