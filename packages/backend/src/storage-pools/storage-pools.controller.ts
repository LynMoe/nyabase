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
import { Capability, zListScope, zPatchStoragePoolRequest } from '@nyabase/common';
import { RequireCaps } from '../iam/decorators/require-caps.decorator.js';
import { CurrentActor } from '../iam/decorators/current-actor.decorator.js';
import type { Actor } from '../iam/actor.js';
import { StoragePoolsService } from './storage-pools.service.js';

/**
 * Storage pools of a server. Listing is `scope=mine` (pools the caller may
 * use) or `scope=all` (`ManageServers`/`ManageGrants`); discovery and
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
  @RequireCaps(Capability.ManageServers)
  @HttpCode(HttpStatus.OK)
  discover(@Param('serverId') serverId: string) {
    return this.service.discover(serverId);
  }

  @Get(':id')
  get(
    @Param('serverId') serverId: string,
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.service.getVisible(id, actor.userId, serverId);
  }

  @Patch(':id')
  @RequireCaps(Capability.ManageStoragePools)
  patch(
    @Param('serverId') serverId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.service.patch(id, zPatchStoragePoolRequest.parse(body), serverId);
  }
}
