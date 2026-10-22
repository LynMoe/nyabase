import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  zCreateContainerRequest,
  zCreateExecSessionRequest,
  zListContainersQuery,
  zListScope,
  zPatchContainerLimitsRequest,
  zPatchContainerRootSizeRequest,
} from '@nyabase/common';
import { CurrentActor } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { ContainerControlService } from './container-control.service.js';

/**
 * One surface for owners and administrators. Authorization is decided by
 * `ContainerControlService`: the owner by default, operators on anyone's
 * container only with the explicit `?scope=all`.
 */
@Controller('containers')
export class ContainersController {
  constructor(private readonly containers: ContainerControlService) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query() query: Record<string, unknown>) {
    return this.containers.list(actor, zListContainersQuery.parse(query));
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.containers.create(actor, zCreateContainerRequest.parse(body));
  }

  @Get(':containerId')
  get(
    @Param('containerId') id: string,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    return this.containers.get(actor, id, zListScope.parse(scope));
  }

  @Post(':containerId/actions/start')
  @HttpCode(HttpStatus.ACCEPTED)
  start(
    @Param('containerId') id: string,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    return this.containers.action(actor, id, 'start', zListScope.parse(scope));
  }

  @Post(':containerId/actions/stop')
  @HttpCode(HttpStatus.ACCEPTED)
  stop(
    @Param('containerId') id: string,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    return this.containers.action(actor, id, 'stop', zListScope.parse(scope));
  }

  @Post(':containerId/actions/restart')
  @HttpCode(HttpStatus.ACCEPTED)
  restart(
    @Param('containerId') id: string,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    return this.containers.action(actor, id, 'restart', zListScope.parse(scope));
  }

  @Post(':containerId/actions/repair-ssh')
  @HttpCode(HttpStatus.ACCEPTED)
  repairSsh(
    @Param('containerId') id: string,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    return this.containers.repairSsh(actor, id, zListScope.parse(scope));
  }

  @Post(':containerId/actions/delete')
  @HttpCode(HttpStatus.ACCEPTED)
  delete(
    @Param('containerId') id: string,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    return this.containers.action(actor, id, 'delete', zListScope.parse(scope));
  }

  @Patch(':containerId/limits')
  @HttpCode(HttpStatus.ACCEPTED)
  limits(
    @Param('containerId') id: string,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Query('scope') scope?: string,
  ) {
    return this.containers.updateLimits(actor, id, zPatchContainerLimitsRequest.parse(body), zListScope.parse(scope));
  }

  @Patch(':containerId/root-size')
  @HttpCode(HttpStatus.ACCEPTED)
  rootSize(
    @Param('containerId') id: string,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Query('scope') scope?: string,
  ) {
    return this.containers.resizeRoot(actor, id, zPatchContainerRootSizeRequest.parse(body), zListScope.parse(scope));
  }

  @Patch(':containerId/gpus')
  @HttpCode(HttpStatus.ACCEPTED)
  gpus(
    @Param('containerId') id: string,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Query('scope') scope?: string,
  ) {
    return this.containers.mutateGpus(actor, id, body, zListScope.parse(scope));
  }

  @Get(':containerId/volumes')
  volumes(
    @Param('containerId') id: string,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    return this.containers.listVolumes(actor, id, zListScope.parse(scope));
  }

  @Get(':containerId/shared-volumes')
  sharedVolumes(
    @Param('containerId') id: string,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    return this.containers.listSharedVolumes(actor, id, zListScope.parse(scope));
  }

  @Get(':containerId/stats')
  stats(
    @Param('containerId') id: string,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    return this.containers.getStats(actor, id, zListScope.parse(scope));
  }

  @Post(':containerId/exec-sessions')
  execSession(
    @Param('containerId') id: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    // Refuse API tokens before looking at the body, as the console always did.
    if (actor.authKind !== 'jwt') {
      throw new ForbiddenException('Container console admission requires a browser JWT');
    }
    return this.containers.createExecSession(actor, id, zCreateExecSessionRequest.parse(body), zListScope.parse(scope));
  }
}
