import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
} from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { CurrentUser } from '../iam/decorators/current-user.decorator.js';
import { RequireAnyCaps, RequireCaps } from '../iam/decorators/require-caps.decorator.js';
import type { UserRecord } from '../iam/user-record.js';
import { GpuService } from './gpu.service.js';

@Controller('admin/servers/:serverId')
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
export class UserGpuController {
  constructor(private readonly gpu: GpuService) {}

  @Get('gpus')
  devices(@Param('serverId') serverId: string, @CurrentUser() user: UserRecord) {
    return this.gpu.listDevicesForUser(user.id, serverId);
  }
}
