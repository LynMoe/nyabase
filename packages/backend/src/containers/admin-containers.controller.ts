import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { UserEntity } from '../entities/user.entity.js';
import { Capability, zExecSessionRequest, zUpdateContainerMountsRequest } from '@nyabase/common';
import { ContainerControlService } from './container-control.service.js';
import type { RequestAuthContext } from '../auth/guards/jwt-auth.guard.js';

@Controller('admin/v2/containers')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageContainersAny)
export class AdminContainersController {
  constructor(private containerControl: ContainerControlService) {}

  @Get()
  async list(@Query('serverId') serverId?: string) {
    return this.containerControl.listForAdmin({ serverId });
  }

  @Get(':containerId')
  async get(@Param('containerId') containerId: string, @CurrentUser() user: UserEntity) {
    return this.containerControl.getForAdmin(containerId, user.id);
  }

  @Post(':containerId/actions/start')
  async start(@Param('containerId') containerId: string, @CurrentUser() user: UserEntity) {
    return this.containerControl.actionForAdmin(containerId, 'start', user.id);
  }

  @Post(':containerId/actions/stop')
  async stop(@Param('containerId') containerId: string, @CurrentUser() user: UserEntity) {
    return this.containerControl.actionForAdmin(containerId, 'stop', user.id);
  }

  @Post(':containerId/actions/restart')
  async restart(@Param('containerId') containerId: string, @CurrentUser() user: UserEntity) {
    return this.containerControl.actionForAdmin(containerId, 'restart', user.id);
  }

  @Post(':containerId/actions/delete')
  async delete(@Param('containerId') containerId: string, @CurrentUser() user: UserEntity) {
    return this.containerControl.actionForAdmin(containerId, 'delete', user.id);
  }

  @Post(':containerId/actions/update-mounts')
  async updateMounts(
    @Param('containerId') containerId: string,
    @Body() body: unknown,
    @CurrentUser() user: UserEntity,
  ) {
    const mounts = zUpdateContainerMountsRequest.parse(body);
    return this.containerControl.actionForAdmin(containerId, 'updateMounts', user.id, mounts);
  }

  @Post(':containerId/actions/reconcile-ssh')
  async reconcileSsh(@Param('containerId') containerId: string, @CurrentUser() user: UserEntity) {
    return this.containerControl.actionForAdmin(containerId, 'reconcileSsh', user.id);
  }

  @Get(':containerId/stats')
  async stats(@Param('containerId') containerId: string, @CurrentUser() user: UserEntity) {
    return this.containerControl.getStatsForAdmin(containerId, user.id);
  }

  @Post(':containerId/exec-sessions')
  async execSession(
    @Param('containerId') containerId: string,
    @Body() body: unknown,
    @CurrentUser() user: UserEntity,
    @Req() httpRequest: { authContext?: RequestAuthContext },
  ) {
    const request = zExecSessionRequest.parse(body);
    if (httpRequest.authContext?.kind !== 'jwt') {
      throw new ForbiddenException('Container console admission requires a browser JWT');
    }
    return this.containerControl.createExecSessionForAdmin(
      containerId,
      user.id,
      httpRequest.authContext.authVersion,
      request,
    );
  }
}
