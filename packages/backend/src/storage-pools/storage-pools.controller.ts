import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { zPatchStoragePoolRequest } from '@nyabase/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { Capability } from '@nyabase/common';
import { StoragePoolsService } from './storage-pools.service.js';

@Controller('servers/:serverId/storage-pools')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class StoragePoolsController {
  constructor(private readonly service: StoragePoolsService) {}

  @Get()
  list(@Param('serverId') serverId: string, @CurrentUser() user: UserRecord) {
    return this.service.listForUser(user.id, serverId);
  }

  @Get(':id')
  get(
    @Param('serverId') serverId: string,
    @Param('id') id: string,
    @CurrentUser() user: UserRecord,
  ) {
    return this.service.getForUser(id, user.id, serverId);
  }
}

@Controller('admin/storage-pools')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageStoragePools)
export class AdminStoragePoolsController {
  constructor(private readonly service: StoragePoolsService) {}

  @Patch(':id')
  patch(@Param('id') id: string, @Body() body: unknown) {
    const input = zPatchStoragePoolRequest.parse(body);
    return this.service.patch(id, input);
  }
}
