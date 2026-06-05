import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { UserEntity } from '../entities/user.entity.js';
import { zCreateContainerRequest, zExecSessionRequest } from '@nyabase/common';
import { z } from 'zod';
import { ContainerControlService } from './container-control.service.js';

const zMountInput = z.object({
  sourceKind: z.enum(['local', 'remote']),
  sourceId: z.string(),
  dirName: z.string().min(1).max(64),
  containerPath: z.string().startsWith('/'),
  createIfMissing: z.boolean().optional(),
});
const zUpdateMounts = z.array(zMountInput);

@Controller('v2/containers')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class ContainersController {
  constructor(private containerControl: ContainerControlService) {}

  @Get()
  async list(
    @CurrentUser() user: UserEntity,
    @Query('serverId') serverId?: string,
  ) {
    return this.containerControl.list(user.id, { serverId });
  }

  @Post()
  async create(@CurrentUser() user: UserEntity, @Body() body: unknown) {
    const request = zCreateContainerRequest.parse(body);
    return this.containerControl.create(user.id, request);
  }

  @Get(':containerId')
  async get(@Param('containerId') containerId: string, @CurrentUser() user: UserEntity) {
    return this.containerControl.get(containerId, user.id);
  }

  @Post(':containerId/actions/start')
  async start(@Param('containerId') containerId: string, @CurrentUser() user: UserEntity) {
    return this.containerControl.action(containerId, 'start', user.id);
  }

  @Post(':containerId/actions/stop')
  async stop(@Param('containerId') containerId: string, @CurrentUser() user: UserEntity) {
    return this.containerControl.action(containerId, 'stop', user.id);
  }

  @Post(':containerId/actions/restart')
  async restart(@Param('containerId') containerId: string, @CurrentUser() user: UserEntity) {
    return this.containerControl.action(containerId, 'restart', user.id);
  }

  @Post(':containerId/actions/delete')
  async delete(@Param('containerId') containerId: string, @CurrentUser() user: UserEntity) {
    return this.containerControl.action(containerId, 'delete', user.id);
  }

  @Post(':containerId/actions/update-mounts')
  async updateMounts(
    @Param('containerId') containerId: string,
    @Body() body: unknown,
    @CurrentUser() user: UserEntity,
  ) {
    zUpdateMounts.parse(body);
    return this.containerControl.action(containerId, 'updateMounts', user.id, body);
  }

  @Post(':containerId/actions/enable-ssh')
  async enableSsh(@Param('containerId') containerId: string, @CurrentUser() user: UserEntity) {
    return this.containerControl.action(containerId, 'enableSsh', user.id);
  }

  @Post(':containerId/actions/reconcile-ssh')
  async reconcileSsh(@Param('containerId') containerId: string, @CurrentUser() user: UserEntity) {
    return this.containerControl.action(containerId, 'reconcileSsh', user.id);
  }

  @Get(':containerId/stats')
  async stats(@Param('containerId') containerId: string, @CurrentUser() user: UserEntity) {
    return this.containerControl.getStats(containerId, user.id);
  }

  @Post(':containerId/exec-sessions')
  async execSession(
    @Param('containerId') containerId: string,
    @Body() body: unknown,
    @CurrentUser() user: UserEntity,
  ) {
    const request = zExecSessionRequest.parse(body);
    return this.containerControl.createExecSession(containerId, user.id, request);
  }
}
