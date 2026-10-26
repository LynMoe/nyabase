import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
} from '@nestjs/common';
import {
  zPutServerGrantRequest,
  zPutSharedBackendGrantRequest,
  zPutStoragePoolGrantRequest,
  type EffectiveAccessDto,
  Role,
} from '@nyabase/common';
import { RequireRole, CurrentActor } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import { GrantsService, type GrantSubject } from './grants.service.js';

const subject = (id: string): GrantSubject => ({ kind: 'user', id });

@Controller('users/:userId')
export class UserGrantsController {
  constructor(
    private readonly grants: GrantsService,
    private readonly access: AccessResolverService,
  ) {}

  @Get('server-grants')
  @RequireRole(Role.UserAdmin)
  listServerGrants(@Param('userId') userId: string) {
    return this.grants.listServerGrants(subject(userId));
  }

  @Put('server-grants/:serverId')
  @RequireRole(Role.UserAdmin)
  upsertServerGrant(
    @Param('userId') userId: string,
    @Param('serverId') serverId: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.putServerGrant(actor, subject(userId), serverId, zPutServerGrantRequest.parse(body));
  }

  @Delete('server-grants/:serverId')
  @RequireRole(Role.UserAdmin)
  deleteServerGrant(
    @Param('userId') userId: string,
    @Param('serverId') serverId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.deleteServerGrant(actor, subject(userId), serverId);
  }

  @Get('storage-pool-grants')
  @RequireRole(Role.UserAdmin)
  listStoragePoolGrants(@Param('userId') userId: string) {
    return this.grants.listStoragePoolGrants(subject(userId));
  }

  @Put('storage-pool-grants/:poolId')
  @RequireRole(Role.UserAdmin)
  upsertStoragePoolGrant(
    @Param('userId') userId: string,
    @Param('poolId') poolId: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.putStoragePoolGrant(
      actor,
      subject(userId),
      poolId,
      zPutStoragePoolGrantRequest.parse(body).expiresAt,
    );
  }

  @Delete('storage-pool-grants/:poolId')
  @RequireRole(Role.UserAdmin)
  deleteStoragePoolGrant(
    @Param('userId') userId: string,
    @Param('poolId') poolId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.deleteStoragePoolGrant(actor, subject(userId), poolId);
  }

  @Get('shared-backend-grants')
  @RequireRole(Role.UserAdmin)
  listSharedBackendGrants(@Param('userId') userId: string) {
    return this.grants.listSharedBackendGrants(subject(userId));
  }

  @Put('shared-backend-grants/:backendId')
  @RequireRole(Role.UserAdmin)
  upsertSharedBackendGrant(
    @Param('userId') userId: string,
    @Param('backendId') backendId: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.putSharedBackendGrant(
      actor,
      subject(userId),
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
    return this.grants.deleteSharedBackendGrant(actor, subject(userId), backendId);
  }

  @Get('effective-access')
  @RequireRole(Role.UserAdmin)
  async effectiveAccess(@Param('userId') userId: string): Promise<EffectiveAccessDto> {
    await this.grants.assertSubjectExists(subject(userId));
    return {
      servers: await this.access.getEffectiveAccess(userId),
      sharedBackends: await this.access.getEffectiveSharedAccess(userId),
    };
  }
}
