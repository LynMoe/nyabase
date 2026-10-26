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
  zAddGroupMemberRequest,
  zCreateGroupRequest,
  zPatchAdminGroupRequest,
  zPutServerGrantRequest,
  zPutSharedBackendGrantRequest,
  zPutStoragePoolGrantRequest,
  Role,
} from '@nyabase/common';
import { RequireRole, CurrentActor } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { GrantsService, type GrantSubject } from './grants.service.js';
import { GroupsService } from './groups.service.js';

const subject = (id: string): GrantSubject => ({ kind: 'group', id });

@Controller('admin/groups')
export class GroupsController {
  constructor(
    private readonly groups: GroupsService,
    private readonly grants: GrantsService,
  ) {}

  @Get()
  @RequireRole(Role.UserAdmin)
  list() {
    return this.groups.findAll();
  }

  @Post()
  @RequireRole(Role.UserAdmin)
  create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.groups.create(actor, zCreateGroupRequest.parse(body));
  }

  @Get(':id')
  @RequireRole(Role.UserAdmin)
  get(@Param('id') id: string) {
    return this.groups.getDto(id);
  }

  @Patch(':id')
  @RequireRole(Role.UserAdmin)
  patch(@Param('id') id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const { expectedRevision, ...input } = zPatchAdminGroupRequest.parse(body);
    return this.groups.update(actor, id, input, expectedRevision);
  }

  @Delete(':id')
  @RequireRole(Role.UserAdmin)
  delete(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.groups.delete(actor, id);
  }

  @Get(':id/members')
  @RequireRole(Role.UserAdmin)
  members(@Param('id') id: string) {
    return this.groups.listMembers(id);
  }

  @Post(':id/members')
  @RequireRole(Role.UserAdmin)
  addMember(@Param('id') id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.groups.addMember(actor, id, zAddGroupMemberRequest.parse(body).userId);
  }

  @Delete(':id/members/:userId')
  @RequireRole(Role.UserAdmin)
  removeMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.groups.removeMember(actor, id, userId);
  }

  @Get(':id/server-grants')
  @RequireRole(Role.UserAdmin)
  serverGrants(@Param('id') id: string) {
    return this.grants.listServerGrants(subject(id));
  }

  @Put(':id/server-grants/:serverId')
  @RequireRole(Role.UserAdmin)
  serverGrant(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.putServerGrant(actor, subject(id), serverId, zPutServerGrantRequest.parse(body));
  }

  @Delete(':id/server-grants/:serverId')
  @RequireRole(Role.UserAdmin)
  deleteServerGrant(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.deleteServerGrant(actor, subject(id), serverId);
  }

  @Get(':id/storage-pool-grants')
  @RequireRole(Role.UserAdmin)
  storagePoolGrants(@Param('id') id: string) {
    return this.grants.listStoragePoolGrants(subject(id));
  }

  @Put(':id/storage-pool-grants/:poolId')
  @RequireRole(Role.UserAdmin)
  storagePoolGrant(
    @Param('id') id: string,
    @Param('poolId') poolId: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    const input = zPutStoragePoolGrantRequest.parse(body);
    return this.grants.putStoragePoolGrant(actor, subject(id), poolId, input.expiresAt);
  }

  @Delete(':id/storage-pool-grants/:poolId')
  @RequireRole(Role.UserAdmin)
  deleteStoragePoolGrant(
    @Param('id') id: string,
    @Param('poolId') poolId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.deleteStoragePoolGrant(actor, subject(id), poolId);
  }

  @Get(':id/shared-backend-grants')
  @RequireRole(Role.UserAdmin)
  sharedBackendGrants(@Param('id') id: string) {
    return this.grants.listSharedBackendGrants(subject(id));
  }

  @Put(':id/shared-backend-grants/:backendId')
  @RequireRole(Role.UserAdmin)
  sharedBackendGrant(
    @Param('id') id: string,
    @Param('backendId') backendId: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.putSharedBackendGrant(
      actor,
      subject(id),
      backendId,
      zPutSharedBackendGrantRequest.parse(body),
    );
  }

  @Delete(':id/shared-backend-grants/:backendId')
  @RequireRole(Role.UserAdmin)
  deleteSharedBackendGrant(
    @Param('id') id: string,
    @Param('backendId') backendId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.deleteSharedBackendGrant(actor, subject(id), backendId);
  }
}
