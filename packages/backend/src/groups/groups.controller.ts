import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  Query,
} from '@nestjs/common';
import { GroupsService } from './groups.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { UserEntity } from '../entities/user.entity.js';
import {
  Capability,
  zCreateGroupRequest, zUpdateAdminGroupRequest, zUpsertServerGrantRequest,
  zAddGroupMemberRequest, zAddImageGrantRequest, zSyncImageGrantServersRequest,
} from '@nyabase/common';
import {
  parseMountSourceGrantTarget,
  zMountSourceGrantTarget,
} from '../mount-sources/mount-source-grant-target.js';

@Controller('admin/groups')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class GroupsController {
  constructor(private groupsService: GroupsService) {}

  @Get()
  @RequireCaps(Capability.ManageGroups)
  async list() {
    return this.groupsService.findAll();
  }

  @Post()
  @RequireCaps(Capability.ManageGroups)
  async create(@Body() body: unknown, @CurrentUser() user: UserEntity) {
    const dto = zCreateGroupRequest.parse(body);
    return this.groupsService.create(dto, user.id);
  }

  @Get(':id')
  @RequireCaps(Capability.ManageGroups)
  async get(@Param('id') id: string) {
    const g = await this.groupsService.findById(id);
    return this.groupsService.toDto(g);
  }

  @Patch(':id')
  @RequireCaps(Capability.ManageGroups)
  async update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: UserEntity) {
    const { expectedRevision, ...dto } = zUpdateAdminGroupRequest.parse(body);
    return this.groupsService.update(id, dto, user.id, expectedRevision);
  }

  @Delete(':id')
  @RequireCaps(Capability.ManageGroups)
  async delete(@Param('id') id: string, @CurrentUser() user: UserEntity) {
    return this.groupsService.delete(id, user.id);
  }

  // ---------------------------------------------------------------------------
  // Members
  // ---------------------------------------------------------------------------

  @Get(':id/members')
  @RequireCaps(Capability.ManageGroups)
  async listMembers(@Param('id') id: string) {
    return this.groupsService.listMembers(id);
  }

  @Post(':id/members')
  @RequireCaps(Capability.ManageGroups)
  async addMember(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: UserEntity) {
    const { userId } = zAddGroupMemberRequest.parse(body);
    const result = await this.groupsService.addMember(id, userId, user.id);
    return { ok: true, ...result };
  }

  @Delete(':id/members/:userId')
  @RequireCaps(Capability.ManageGroups)
  async removeMember(@Param('id') id: string, @Param('userId') userId: string, @CurrentUser() user: UserEntity) {
    return this.groupsService.removeMember(id, userId, user.id);
  }

  // ---------------------------------------------------------------------------
  // Server grants (group scope)
  // ---------------------------------------------------------------------------

  @Get(':id/server-grants')
  @RequireCaps(Capability.ManageGrants)
  async listServerGrants(@Param('id') id: string) {
    return this.groupsService.listGroupServerGrants(id);
  }

  @Post(':id/server-grants/:serverId')
  @RequireCaps(Capability.ManageGrants)
  async upsertServerGrant(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Body() body: unknown,
    @CurrentUser() user: UserEntity,
  ) {
    const dto = zUpsertServerGrantRequest.parse(body);
    return this.groupsService.upsertGroupServerGrant(id, serverId, dto, user.id);
  }

  @Delete(':id/server-grants/:serverId')
  @RequireCaps(Capability.ManageGrants)
  async deleteServerGrant(@Param('id') id: string, @Param('serverId') serverId: string, @CurrentUser() user: UserEntity) {
    return this.groupsService.deleteGroupServerGrant(id, serverId, user.id);
  }

  // ---------------------------------------------------------------------------
  // Image grants (group scope)
  // ---------------------------------------------------------------------------

  @Get(':id/image-grants')
  @RequireCaps(Capability.ManageGrants)
  async listImageGrants(@Param('id') id: string) {
    return this.groupsService.listGroupImageGrants(id);
  }

  @Post(':id/image-grants')
  @RequireCaps(Capability.ManageGrants)
  async addImageGrant(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() actor: UserEntity,
  ) {
    const { imageId, serverId } = zAddImageGrantRequest.parse(body);
    return this.groupsService.addGroupImageGrant(id, imageId, serverId, actor.id);
  }

  /** Bulk-sync image grants for a specific image across a set of servers */
  @Post(':id/image-grants/:imageId/sync-servers')
  @RequireCaps(Capability.ManageGrants)
  async syncImageGrantServers(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @Body() body: unknown,
    @CurrentUser() actor: UserEntity,
  ) {
    const { serverIds } = zSyncImageGrantServersRequest.parse(body);
    return this.groupsService.syncGroupImageGrantsForServers(id, imageId, serverIds, actor.id);
  }

  @Delete(':id/image-grants/:imageId/:serverId')
  @RequireCaps(Capability.ManageGrants)
  @HttpCode(204)
  async deleteImageGrant(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @Param('serverId') serverId: string,
    @CurrentUser() actor: UserEntity,
  ) {
    await this.groupsService.deleteGroupImageGrant(id, imageId, serverId, actor.id);
  }

  // ---------------------------------------------------------------------------
  // Mount source grants
  // ---------------------------------------------------------------------------

  @Get(':id/mount-source-grants')
  @RequireCaps(Capability.ManageGrants)
  async listMountSourceGrants(@Param('id') id: string) {
    return this.groupsService.listGroupMountSourceGrants(id);
  }

  @Post(':id/mount-source-grants')
  @RequireCaps(Capability.ManageGrants)
  async upsertMountSourceGrant(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() actor: UserEntity,
  ) {
    const target = zMountSourceGrantTarget.parse(body);
    return this.groupsService.upsertGroupMountSourceGrant(actor.id, id, target);
  }

  @Delete(':id/mount-source-grants/:sourceKind/:sourceId')
  @RequireCaps(Capability.ManageGrants)
  @HttpCode(204)
  async deleteMountSourceGrant(
    @Param('id') id: string,
    @Param('sourceKind') sourceKind: string,
    @Param('sourceId') sourceId: string,
    @Query('serverId') serverId: string | undefined,
    @CurrentUser() actor: UserEntity,
  ) {
    const target = parseMountSourceGrantTarget(sourceKind, sourceId, serverId);
    await this.groupsService.deleteGroupMountSourceGrant(actor.id, id, target);
  }
}
