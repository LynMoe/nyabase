import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { GroupsService } from './groups.service.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { UserEntity } from '../entities/user.entity.js';
import { Capability, zUpsertServerGrantRequest, zAddImageGrantRequest, EffectiveAccessDto, MountSourceKind } from '@nyabase/common';
import { z } from 'zod';

const zUpsertMountSourceGrantBody = z.object({
  sourceKind: z.enum(['local', 'remote']),
  sourceId: z.string().uuid(),
});

@Controller('admin/users/:userId')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class UserGrantsController {
  constructor(
    private groupsService: GroupsService,
    private accessResolver: AccessResolverService,
  ) {}

  @Get('server-grants')
  @RequireCaps(Capability.ManageGrants)
  async listUserServerGrants(@Param('userId') userId: string) {
    return this.groupsService.listUserServerGrants(userId);
  }

  @Post('server-grants/:serverId')
  @RequireCaps(Capability.ManageGrants)
  async upsertUserServerGrant(
    @Param('userId') userId: string,
    @Param('serverId') serverId: string,
    @Body() body: unknown,
    @CurrentUser() actor: UserEntity,
  ) {
    const dto = zUpsertServerGrantRequest.parse(body);
    return this.groupsService.upsertUserServerGrant(userId, serverId, dto, actor.id);
  }

  @Delete('server-grants/:serverId')
  @RequireCaps(Capability.ManageGrants)
  @HttpCode(204)
  async deleteUserServerGrant(
    @Param('userId') userId: string,
    @Param('serverId') serverId: string,
    @CurrentUser() actor: UserEntity,
  ) {
    await this.groupsService.deleteUserServerGrant(userId, serverId, actor.id);
  }

  @Get('image-grants')
  @RequireCaps(Capability.ManageGrants)
  async listUserImageGrants(@Param('userId') userId: string) {
    return this.groupsService.listUserImageGrants(userId);
  }

  @Post('image-grants')
  @RequireCaps(Capability.ManageGrants)
  async addUserImageGrant(
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    const { imageId, serverId } = zAddImageGrantRequest.parse(body);
    return this.groupsService.addUserImageGrant(userId, imageId, serverId);
  }

  @Delete('image-grants/:imageId/:serverId')
  @RequireCaps(Capability.ManageGrants)
  @HttpCode(204)
  async deleteUserImageGrant(
    @Param('userId') userId: string,
    @Param('imageId') imageId: string,
    @Param('serverId') serverId: string,
  ) {
    await this.groupsService.deleteUserImageGrant(userId, imageId, serverId);
  }

  @Get('mount-source-grants')
  @RequireCaps(Capability.ManageGrants)
  async listUserMountSourceGrants(@Param('userId') userId: string) {
    return this.groupsService.listUserMountSourceGrants(userId);
  }

  @Post('mount-source-grants')
  @RequireCaps(Capability.ManageGrants)
  async upsertUserMountSourceGrant(
    @Param('userId') userId: string,
    @Body() body: unknown,
    @CurrentUser() actor: UserEntity,
  ) {
    const { sourceKind, sourceId } = zUpsertMountSourceGrantBody.parse(body);
    return this.groupsService.upsertUserMountSourceGrant(actor.id, userId, sourceKind as MountSourceKind, sourceId);
  }

  @Delete('mount-source-grants/:sourceKind/:sourceId')
  @RequireCaps(Capability.ManageGrants)
  @HttpCode(204)
  async deleteUserMountSourceGrant(
    @Param('userId') userId: string,
    @Param('sourceKind') sourceKind: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() actor: UserEntity,
  ) {
    await this.groupsService.deleteUserMountSourceGrant(actor.id, userId, sourceKind as MountSourceKind, sourceId);
  }

  @Get('effective-access')
  @RequireCaps(Capability.ManageGrants)
  async effectiveAccess(@Param('userId') userId: string): Promise<EffectiveAccessDto> {
    const servers = await this.accessResolver.getEffectiveAccess(userId);
    return { servers };
  }
}
