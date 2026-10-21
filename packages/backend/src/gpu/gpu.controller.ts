import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { Capability, zListScope } from '@nyabase/common';
import { CurrentActor, RequireCaps } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { GpuService } from './gpu.service.js';

/** GPU of a server: enablement is `ManageServers`; device listing is `scope`d. */
@Controller('servers/:serverId')
export class GpuController {
  constructor(private readonly gpu: GpuService) {}

  @Get('gpu')
  @RequireCaps(Capability.ManageServers)
  get(@Param('serverId') serverId: string) {
    return this.gpu.getServerGpu(serverId);
  }

  @Patch('gpu')
  @RequireCaps(Capability.ManageServers)
  patch(
    @Param('serverId') serverId: string,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ) {
    return this.gpu.setEnabled(actor.userId, serverId, body);
  }

  @Get('gpus')
  devices(
    @Param('serverId') serverId: string,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    return this.gpu.listDevices(actor, serverId, zListScope.parse(scope));
  }
}
