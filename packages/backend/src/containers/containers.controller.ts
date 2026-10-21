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
  zPatchContainerLimitsRequest,
  zPatchContainerRootSizeRequest,
} from '@nyabase/common';
import { CurrentActor } from '../iam/decorators/current-actor.decorator.js';
import type { Actor } from '../iam/actor.js';
import { ContainerControlService } from './container-control.service.js';

/**
 * One surface for owners and administrators. Authorization (owner, or
 * `ManageContainersAny`) is decided by `ContainerControlService`.
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
  get(@Param('containerId') id: string, @CurrentActor() actor: Actor) {
    return this.containers.get(actor, id);
  }

  @Post(':containerId/actions/start')
  @HttpCode(HttpStatus.ACCEPTED)
  start(@Param('containerId') id: string, @CurrentActor() actor: Actor) {
    return this.containers.action(actor, id, 'start');
  }

  @Post(':containerId/actions/stop')
  @HttpCode(HttpStatus.ACCEPTED)
  stop(@Param('containerId') id: string, @CurrentActor() actor: Actor) {
    return this.containers.action(actor, id, 'stop');
  }

  @Post(':containerId/actions/restart')
  @HttpCode(HttpStatus.ACCEPTED)
  restart(@Param('containerId') id: string, @CurrentActor() actor: Actor) {
    return this.containers.action(actor, id, 'restart');
  }

  @Post(':containerId/actions/repair-ssh')
  @HttpCode(HttpStatus.ACCEPTED)
  repairSsh(@Param('containerId') id: string, @CurrentActor() actor: Actor) {
    return this.containers.repairSsh(actor, id);
  }

  @Post(':containerId/actions/delete')
  @HttpCode(HttpStatus.ACCEPTED)
  delete(@Param('containerId') id: string, @CurrentActor() actor: Actor) {
    return this.containers.action(actor, id, 'delete');
  }

  @Patch(':containerId/limits')
  @HttpCode(HttpStatus.ACCEPTED)
  limits(@Param('containerId') id: string, @CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.containers.updateLimits(actor, id, zPatchContainerLimitsRequest.parse(body));
  }

  @Patch(':containerId/root-size')
  @HttpCode(HttpStatus.ACCEPTED)
  rootSize(@Param('containerId') id: string, @CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.containers.resizeRoot(actor, id, zPatchContainerRootSizeRequest.parse(body));
  }

  @Patch(':containerId/gpus')
  @HttpCode(HttpStatus.ACCEPTED)
  gpus(@Param('containerId') id: string, @CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.containers.mutateGpus(actor, id, body);
  }

  @Get(':containerId/volumes')
  volumes(@Param('containerId') id: string, @CurrentActor() actor: Actor) {
    return this.containers.listVolumes(actor, id);
  }

  @Get(':containerId/shared-volumes')
  sharedVolumes(@Param('containerId') id: string, @CurrentActor() actor: Actor) {
    return this.containers.listSharedVolumes(actor, id);
  }

  @Get(':containerId/stats')
  stats(@Param('containerId') id: string, @CurrentActor() actor: Actor) {
    return this.containers.getStats(actor, id);
  }

  @Post(':containerId/exec-sessions')
  execSession(
    @Param('containerId') id: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    // Refuse API tokens before looking at the body, as the console always did.
    if (actor.authKind !== 'jwt') {
      throw new ForbiddenException('Container console admission requires a browser JWT');
    }
    return this.containers.createExecSession(actor, id, zCreateExecSessionRequest.parse(body));
  }
}
