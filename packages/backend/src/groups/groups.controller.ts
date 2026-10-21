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
  Capability,
  zAddGroupMemberRequest,
  zCreateGroupRequest,
  zPatchAdminGroupRequest,
  zPutServerGrantRequest,
  zPutSharedBackendGrantRequest,
  zPutStoragePoolGrantRequest,
} from '@nyabase/common';
import { RequireAnyCaps, RequireCaps, CurrentActor } from '../iam/decorators.js';
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
  @RequireCaps()
  @RequireAnyCaps(Capability.ManageGroups, Capability.ManageGrants)
  list() {
    return this.groups.findAll();
  }

  @Post()
  @RequireCaps(Capability.ManageGroups)
  create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.groups.create(actor, zCreateGroupRequest.parse(body));
  }

  @Get(':id')
  @RequireCaps()
  @RequireAnyCaps(Capability.ManageGroups, Capability.ManageGrants)
  get(@Param('id') id: string) {
    return this.groups.getDto(id);
  }

  @Patch(':id')
  @RequireCaps(Capability.ManageGroups)
  patch(@Param('id') id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const { expectedRevision, ...input } = zPatchAdminGroupRequest.parse(body);
    return this.groups.update(actor, id, input, expectedRevision);
  }

  @Delete(':id')
  @RequireCaps(Capability.ManageGroups)
  delete(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.groups.delete(actor, id);
  }

  @Get(':id/members')
  @RequireCaps(Capability.ManageGroups)
  members(@Param('id') id: string) {
    return this.groups.listMembers(id);
  }

  @Post(':id/members')
  @RequireCaps(Capability.ManageGroups)
  addMember(@Param('id') id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.groups.addMember(actor, id, zAddGroupMemberRequest.parse(body).userId);
  }

  @Delete(':id/members/:userId')
  @RequireCaps(Capability.ManageGroups)
  removeMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.groups.removeMember(actor, id, userId);
  }

  @Get(':id/server-grants')
  @RequireCaps(Capability.ManageGrants)
  serverGrants(@Param('id') id: string) {
    return this.grants.listServerGrants(subject(id));
  }

  @Put(':id/server-grants/:serverId')
  @RequireCaps(Capability.ManageGrants)
  serverGrant(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.putServerGrant(actor, subject(id), serverId, zPutServerGrantRequest.parse(body));
  }

  @Delete(':id/server-grants/:serverId')
  @RequireCaps(Capability.ManageGrants)
  deleteServerGrant(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.deleteServerGrant(actor, subject(id), serverId);
  }

  @Get(':id/storage-pool-grants')
  @RequireCaps(Capability.ManageGrants)
  storagePoolGrants(@Param('id') id: string) {
    return this.grants.listStoragePoolGrants(subject(id));
  }

  @Put(':id/storage-pool-grants/:poolId')
  @RequireCaps(Capability.ManageGrants)
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
  @RequireCaps(Capability.ManageGrants)
  deleteStoragePoolGrant(
    @Param('id') id: string,
    @Param('poolId') poolId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.deleteStoragePoolGrant(actor, subject(id), poolId);
  }

  @Get(':id/shared-backend-grants')
  @RequireCaps(Capability.ManageGrants)
  sharedBackendGrants(@Param('id') id: string) {
    return this.grants.listSharedBackendGrants(subject(id));
  }

  @Put(':id/shared-backend-grants/:backendId')
  @RequireCaps(Capability.ManageGrants)
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
  @RequireCaps(Capability.ManageGrants)
  deleteSharedBackendGrant(
    @Param('id') id: string,
    @Param('backendId') backendId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.grants.deleteSharedBackendGrant(actor, subject(id), backendId);
  }
}
