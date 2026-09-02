import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequireAnyCaps, RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { ServerCardExtensionsService } from './server-extensions.service.js';

@Controller('admin/servers/:serverId/extensions')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageServers)
export class AdminServerExtensionsController {
  constructor(private readonly extensions: ServerCardExtensionsService) {}

  @Get()
  list(@Param('serverId') serverId: string) {
    return this.extensions.listEnablement(serverId);
  }

  @Put(':extensionId')
  put(
    @Param('serverId') serverId: string,
    @Param('extensionId') extensionId: string,
    @CurrentUser() actor: UserRecord,
    @Body() body: unknown,
  ) {
    return this.extensions.putEnablement(actor.id, serverId, extensionId, body);
  }

  @Get(':extensionId/devices')
  @RequireCaps()
  @RequireAnyCaps(Capability.ManageServers, Capability.ManageGrants)
  devices(
    @Param('serverId') serverId: string,
    @Param('extensionId') extensionId: string,
  ) {
    return this.extensions.listDevicesForAdmin(serverId, extensionId);
  }
}

@Controller('servers/:serverId/extensions')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class UserServerExtensionsController {
  constructor(private readonly extensions: ServerCardExtensionsService) {}

  @Get(':extensionId/devices')
  devices(
    @Param('serverId') serverId: string,
    @Param('extensionId') extensionId: string,
    @CurrentUser() user: UserRecord,
  ) {
    return this.extensions.listDevicesForUser(user.id, serverId, extensionId);
  }
}
