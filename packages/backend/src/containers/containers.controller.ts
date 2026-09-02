import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  ForbiddenException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  zCreateContainerRequest,
  zCreateExecSessionRequest,
  zPatchContainerLimitsRequest,
  zPatchContainerRootSizeRequest,
} from '@nyabase/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import type { RequestAuthContext } from '../auth/guards/jwt-auth.guard.js';
import { ContainerControlService } from './container-control.service.js';

@Controller('containers')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class ContainersController {
  constructor(private readonly containers: ContainerControlService) {}

  @Get()
  list(@CurrentUser() user: UserRecord, @Query('serverId') serverId?: string) {
    return this.containers.list(user.id, { serverId });
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(@CurrentUser() user: UserRecord, @Body() body: unknown) {
    return this.containers.createForUser(user.id, zCreateContainerRequest.parse(body));
  }

  @Get(':containerId')
  get(@Param('containerId') id: string, @CurrentUser() user: UserRecord) {
    return this.containers.get(id, user.id);
  }

  @Post(':containerId/actions/start')
  @HttpCode(HttpStatus.ACCEPTED)
  start(@Param('containerId') id: string, @CurrentUser() user: UserRecord) {
    return this.containers.action(id, 'start', user.id);
  }

  @Post(':containerId/actions/stop')
  @HttpCode(HttpStatus.ACCEPTED)
  stop(@Param('containerId') id: string, @CurrentUser() user: UserRecord) {
    return this.containers.action(id, 'stop', user.id);
  }

  @Post(':containerId/actions/restart')
  @HttpCode(HttpStatus.ACCEPTED)
  restart(@Param('containerId') id: string, @CurrentUser() user: UserRecord) {
    return this.containers.action(id, 'restart', user.id);
  }

  @Post(':containerId/actions/repair-ssh')
  @HttpCode(HttpStatus.ACCEPTED)
  repairSsh(@Param('containerId') id: string, @CurrentUser() user: UserRecord) {
    return this.containers.repairSsh(id, user.id);
  }

  @Post(':containerId/actions/delete')
  @HttpCode(HttpStatus.ACCEPTED)
  delete(@Param('containerId') id: string, @CurrentUser() user: UserRecord) {
    return this.containers.action(id, 'delete', user.id);
  }

  @Patch(':containerId/limits')
  @HttpCode(HttpStatus.ACCEPTED)
  limits(@Param('containerId') id: string, @CurrentUser() user: UserRecord, @Body() body: unknown) {
    return this.containers.updateLimitsForUser(id, user.id, zPatchContainerLimitsRequest.parse(body));
  }

  @Patch(':containerId/root-size')
  @HttpCode(HttpStatus.ACCEPTED)
  rootSize(@Param('containerId') id: string, @CurrentUser() user: UserRecord, @Body() body: unknown) {
    return this.containers.resizeRootForUser(id, user.id, zPatchContainerRootSizeRequest.parse(body));
  }

  @Patch(':containerId/extensions/:extensionId')
  @HttpCode(HttpStatus.ACCEPTED)
  extension(
    @Param('containerId') id: string,
    @Param('extensionId') extensionId: string,
    @CurrentUser() user: UserRecord,
    @Body() body: unknown,
  ) {
    return this.containers.mutateExtensionForUser(id, user.id, extensionId, body);
  }

  @Get(':containerId/volumes')
  volumes(@Param('containerId') id: string, @CurrentUser() user: UserRecord) {
    return this.containers.listVolumesForUser(id, user.id);
  }

  @Get(':containerId/shared-volumes')
  sharedVolumes(@Param('containerId') id: string, @CurrentUser() user: UserRecord) {
    return this.containers.listSharedVolumesForUser(id, user.id);
  }

  @Get(':containerId/stats')
  stats(@Param('containerId') id: string, @CurrentUser() user: UserRecord) {
    return this.containers.getStats(id, user.id);
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
    return this.containers.createExecSession(
      id,
      user.id,
      request.authContext.authVersion,
      zCreateExecSessionRequest.parse(body),
    );
  }
}
