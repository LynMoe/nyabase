import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  Capability,
  zCreateContainerRequest,
  zCreateExecSessionRequest,
  zPatchContainerGpuRequest,
  zPatchContainerLimitsRequest,
  zPatchContainerRootSizeRequest,
} from '@nyabase/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import type { RequestAuthContext } from '../auth/guards/jwt-auth.guard.js';
import { ContainerControlService } from './container-control.service.js';

@Controller('admin/containers')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageContainersAny)
export class AdminContainersController {
  constructor(private readonly containers: ContainerControlService) {}

  @Get()
  list(@Query('serverId') serverId?: string) {
    return this.containers.listForAdmin({ serverId });
  }

  @Get(':containerId')
  get(@Param('containerId') id: string, @CurrentUser() user: UserRecord) {
    return this.containers.getForAdmin(id, user.id);
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(@CurrentUser() user: UserRecord, @Body() body: unknown) {
    return this.containers.createForAdmin(user.id, zCreateContainerRequest.parse(body));
  }

  @Post(':containerId/actions/start')
  @HttpCode(HttpStatus.ACCEPTED)
  start(@Param('containerId') id: string, @CurrentUser() user: UserRecord) {
    return this.containers.actionForAdmin(id, 'start', user.id);
  }

  @Post(':containerId/actions/stop')
  @HttpCode(HttpStatus.ACCEPTED)
  stop(@Param('containerId') id: string, @CurrentUser() user: UserRecord) {
    return this.containers.actionForAdmin(id, 'stop', user.id);
  }

  @Post(':containerId/actions/restart')
  @HttpCode(HttpStatus.ACCEPTED)
  restart(@Param('containerId') id: string, @CurrentUser() user: UserRecord) {
    return this.containers.actionForAdmin(id, 'restart', user.id);
  }

  @Post(':containerId/actions/repair-ssh')
  @HttpCode(HttpStatus.ACCEPTED)
  repairSsh(@Param('containerId') id: string, @CurrentUser() user: UserRecord) {
    return this.containers.repairSshForAdmin(id, user.id);
  }

  @Post(':containerId/actions/delete')
  @HttpCode(HttpStatus.ACCEPTED)
  delete(@Param('containerId') id: string, @CurrentUser() user: UserRecord) {
    return this.containers.actionForAdmin(id, 'delete', user.id);
  }

  @Patch(':containerId/limits')
  @HttpCode(HttpStatus.ACCEPTED)
  limits(@Param('containerId') id: string, @CurrentUser() user: UserRecord, @Body() body: unknown) {
    return this.containers.updateLimitsForAdmin(
      id,
      user.id,
      zPatchContainerLimitsRequest.parse(body),
    );
  }

  @Patch(':containerId/root-size')
  @HttpCode(HttpStatus.ACCEPTED)
  rootSize(@Param('containerId') id: string, @CurrentUser() user: UserRecord, @Body() body: unknown) {
    return this.containers.resizeRootForAdmin(
      id,
      user.id,
      zPatchContainerRootSizeRequest.parse(body),
    );
  }

  @Patch(':containerId/gpu')
  @HttpCode(HttpStatus.ACCEPTED)
  gpu(@Param('containerId') id: string, @CurrentUser() user: UserRecord, @Body() body: unknown) {
    return this.containers.updateGpuForAdmin(
      id,
      user.id,
      zPatchContainerGpuRequest.parse(body),
    );
  }

  @Get(':containerId/volumes')
  volumes(@Param('containerId') id: string) {
    return this.containers.listVolumesForAdmin(id);
  }

  @Get(':containerId/shared-volumes')
  sharedVolumes(@Param('containerId') id: string) {
    return this.containers.listSharedVolumesForAdmin(id);
  }

  @Get(':containerId/stats')
  stats(@Param('containerId') id: string, @CurrentUser() user: UserRecord) {
    return this.containers.getStatsForAdmin(id, user.id);
  }

  @Post(':containerId/exec-sessions')
  execSession(
    @Param('containerId') id: string,
    @Body() body: unknown,
    @CurrentUser() user: UserRecord,
    @Req() request: { authContext?: RequestAuthContext },
  ) {
    if (request.authContext?.kind !== 'jwt') {
      throw new ForbiddenException('Container console admission requires a browser JWT');
    }
    return this.containers.createExecSessionForAdmin(
      id,
      user.id,
      request.authContext.authVersion,
      zCreateExecSessionRequest.parse(body),
    );
  }
}
