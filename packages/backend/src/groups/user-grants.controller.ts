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
import { CurrentActor } from '../iam/decorators/current-actor.decorator.js';
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
  @RequireCaps(Capability.ManageGrants)
  listServerGrants(@Param('userId') userId: string) {
    return this.grants.listServerGrants(subject(userId));
  }

  @Put('server-grants/:serverId')
  @RequireCaps(Capability.ManageGrants)
  upsertServerGrant(
    @Param('userId') userId: string,
    @Param('serverId') serverId: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.putServerGrant(actor, subject(userId), serverId, zPutServerGrantRequest.parse(body));
  }

  @Delete('server-grants/:serverId')
  @RequireCaps(Capability.ManageGrants)
  deleteServerGrant(
    @Param('userId') userId: string,
    @Param('serverId') serverId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.deleteServerGrant(actor, subject(userId), serverId);
  }

  @Get('storage-pool-grants')
  @RequireCaps(Capability.ManageGrants)
  listStoragePoolGrants(@Param('userId') userId: string) {
    return this.grants.listStoragePoolGrants(subject(userId));
  }

  @Put('storage-pool-grants/:poolId')
  @RequireCaps(Capability.ManageGrants)
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
  @RequireCaps(Capability.ManageGrants)
  deleteStoragePoolGrant(
    @Param('userId') userId: string,
    @Param('poolId') poolId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.deleteStoragePoolGrant(actor, subject(userId), poolId);
  }

  @Get('shared-backend-grants')
  @RequireCaps(Capability.ManageGrants)
  listSharedBackendGrants(@Param('userId') userId: string) {
    return this.grants.listSharedBackendGrants(subject(userId));
  }

  @Put('shared-backend-grants/:backendId')
  @RequireCaps(Capability.ManageGrants)
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
  @RequireCaps(Capability.ManageGrants)
  deleteSharedBackendGrant(
    @Param('userId') userId: string,
    @Param('backendId') backendId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.deleteSharedBackendGrant(actor, subject(userId), backendId);
  }

  @Get('effective-access')
  @RequireCaps(Capability.ManageGrants)
  async effectiveAccess(@Param('userId') userId: string): Promise<EffectiveAccessDto> {
    await this.grants.assertSubjectExists(subject(userId));
    return {
      servers: await this.access.getEffectiveAccess(userId),
      sharedBackends: await this.access.getEffectiveSharedAccess(userId),
    };
  }
}
