import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { zListScope, Role } from '@nyabase/common';
import { CurrentActor, RequireRole } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { GpuService } from './gpu.service.js';
import { requireUserId } from '../iam/actor.js';

/** GPU of a server: enablement is operator-only; device listing is `scope`d. */
@Controller('servers/:serverId')
export class GpuController {
  constructor(private readonly gpu: GpuService) {}

  @Get('gpu')
  @RequireRole(Role.Operator)
  get(@Param('serverId') serverId: string) {
    return this.gpu.getServerGpu(serverId);
  }

  @Patch('gpu')
  @RequireRole(Role.Operator)
  patch(
    @Param('serverId') serverId: string,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ) {
    return this.gpu.setEnabled(requireUserId(actor), serverId, body);
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
