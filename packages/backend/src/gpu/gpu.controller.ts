import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequireAnyCaps, RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { GpuService } from './gpu.service.js';

@Controller('admin/servers/:serverId')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageServers)
export class AdminGpuController {
  constructor(private readonly gpu: GpuService) {}

  @Get('gpu')
  get(@Param('serverId') serverId: string) {
    return this.gpu.getServerGpu(serverId);
  }

  @Patch('gpu')
  patch(
    @Param('serverId') serverId: string,
    @CurrentUser() actor: UserRecord,
    @Body() body: unknown,
  ) {
    return this.gpu.setEnabled(actor.id, serverId, body);
  }

  @Get('gpus')
  @RequireCaps()
  @RequireAnyCaps(Capability.ManageServers, Capability.ManageGrants)
  devices(@Param('serverId') serverId: string) {
    return this.gpu.listDevicesForAdmin(serverId);
  }
}

@Controller('servers/:serverId')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class UserGpuController {
  constructor(private readonly gpu: GpuService) {}

  @Get('gpus')
  devices(@Param('serverId') serverId: string, @CurrentUser() user: UserRecord) {
    return this.gpu.listDevicesForUser(user.id, serverId);
  }
}
