import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { zListScope, zPatchStoragePoolRequest, Role } from '@nyabase/common';
import { RequireRole, CurrentActor } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { StoragePoolsService } from './storage-pools.service.js';
import { requireUserId } from '../iam/actor.js';

/**
 * Storage pools of a server. Listing is `scope=mine` (pools the caller may
 * use) or `scope=all` (operator); discovery and
 * registration changes are administrator-only.
 */
@Controller('servers/:serverId/storage-pools')
export class StoragePoolsController {
  constructor(private readonly service: StoragePoolsService) {}

  @Get()
  list(
    @Param('serverId') serverId: string,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    return this.service.listForServer(actor, serverId, zListScope.parse(scope));
  }

  @Post('discover')
  @RequireRole(Role.Operator)
  @HttpCode(HttpStatus.OK)
  discover(@Param('serverId') serverId: string, @CurrentActor() actor: Actor) {
    return this.service.discover(requireUserId(actor), serverId);
  }

  @Get(':id')
  get(
    @Param('serverId') serverId: string,
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.service.getVisible(id, requireUserId(actor), serverId);
  }

  @Patch(':id')
  @RequireRole(Role.Admin)
  patch(
    @Param('serverId') serverId: string,
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ) {
    return this.service.patch(requireUserId(actor), id, zPatchStoragePoolRequest.parse(body), serverId);
  }
}
