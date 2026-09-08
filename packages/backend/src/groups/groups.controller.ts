import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  Capability,
  zAddGroupMemberRequest,
  zPatchAdminGroupRequest,
  zPutServerGrantRequest,
  zPutSharedBackendGrantRequest,
  zPutStoragePoolGrantRequest,
  zCreateGroupRequest,
} from '@nyabase/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireAnyCaps, RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { GroupsService } from './groups.service.js';

@Controller('admin/groups')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  @RequireCaps()
  @RequireAnyCaps(Capability.ManageGroups, Capability.ManageGrants)
  list() {
    return this.groups.findAll();
  }

  @Post()
  @RequireCaps(Capability.ManageGroups)
  create(@Body() body: unknown, @CurrentUser() user: UserRecord) {
    return this.groups.create(zCreateGroupRequest.parse(body), user.id);
  }

  @Get(':id')
  @RequireCaps()
  @RequireAnyCaps(Capability.ManageGroups, Capability.ManageGrants)
  get(@Param('id') id: string) {
    return this.groups.getDto(id);
  }

  @Patch(':id')
  @RequireCaps(Capability.ManageGroups)
  patch(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: UserRecord) {
    const parsed = zPatchAdminGroupRequest.parse(body);
    const { expectedRevision, ...input } = parsed;
    return this.groups.update(id, input, user.id, expectedRevision);
  }

  @Delete(':id')
  @RequireCaps(Capability.ManageGroups)
  delete(@Param('id') id: string, @CurrentUser() user: UserRecord) {
    return this.groups.delete(id, user.id);
  }

  @Get(':id/members')
  @RequireCaps(Capability.ManageGroups)
  members(@Param('id') id: string) {
    return this.groups.listMembers(id);
  }

  @Post(':id/members')
  @RequireCaps(Capability.ManageGroups)
  addMember(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: UserRecord) {
    return this.groups.addMember(id, zAddGroupMemberRequest.parse(body).userId, user.id);
  }

  @Delete(':id/members/:userId')
  @RequireCaps(Capability.ManageGroups)
  removeMember(@Param('id') id: string, @Param('userId') userId: string, @CurrentUser() user: UserRecord) {
    return this.groups.removeMember(id, userId, user.id);
  }

  @Get(':id/server-grants')
  @RequireCaps(Capability.ManageGrants)
  serverGrants(@Param('id') id: string) {
    return this.groups.listGroupServerGrants(id);
  }

  @Put(':id/server-grants/:serverId')
  @RequireCaps(Capability.ManageGrants)
  serverGrant(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Body() body: unknown,
    @CurrentUser() user: UserRecord,
  ) {
    return this.groups.upsertGroupServerGrant(id, serverId, zPutServerGrantRequest.parse(body), user.id);
  }

  @Delete(':id/server-grants/:serverId')
  @RequireCaps(Capability.ManageGrants)
  deleteServerGrant(@Param('id') id: string, @Param('serverId') serverId: string, @CurrentUser() user: UserRecord) {
    return this.groups.deleteGroupServerGrant(id, serverId, user.id);
  }

  @Get(':id/storage-pool-grants')
  @RequireCaps(Capability.ManageGrants)
  storagePoolGrants(@Param('id') id: string) {
    return this.groups.listGroupStoragePoolGrants(id);
  }

  @Put(':id/storage-pool-grants/:poolId')
  @RequireCaps(Capability.ManageGrants)
  storagePoolGrant(
    @Param('id') id: string,
    @Param('poolId') poolId: string,
    @Body() body: unknown,
    @CurrentUser() user: UserRecord,
  ) {
    const input = zPutStoragePoolGrantRequest.parse(body);
    return this.groups.upsertGroupStoragePoolGrant(id, poolId, input.expiresAt, user.id);
  }

  @Delete(':id/storage-pool-grants/:poolId')
  @RequireCaps(Capability.ManageGrants)
  deleteStoragePoolGrant(@Param('id') id: string, @Param('poolId') poolId: string, @CurrentUser() user: UserRecord) {
    return this.groups.deleteGroupStoragePoolGrant(id, poolId, user.id);
  }

  @Get(':id/shared-backend-grants')
  @RequireCaps(Capability.ManageGrants)
  sharedBackendGrants(@Param('id') id: string) {
    return this.groups.listGroupSharedBackendGrants(id);
  }

  @Put(':id/shared-backend-grants/:backendId')
  @RequireCaps(Capability.ManageGrants)
  sharedBackendGrant(
    @Param('id') id: string,
    @Param('backendId') backendId: string,
    @Body() body: unknown,
    @CurrentUser() user: UserRecord,
  ) {
    return this.groups.upsertGroupSharedBackendGrant(
      id,
      backendId,
      zPutSharedBackendGrantRequest.parse(body),
      user.id,
    );
  }

  @Delete(':id/shared-backend-grants/:backendId')
  @RequireCaps(Capability.ManageGrants)
  deleteSharedBackendGrant(@Param('id') id: string, @Param('backendId') backendId: string, @CurrentUser() user: UserRecord) {
    return this.groups.deleteGroupSharedBackendGrant(id, backendId, user.id);
  }
}
