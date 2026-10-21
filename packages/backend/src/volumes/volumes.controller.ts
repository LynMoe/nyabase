import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  FailureCode,
  zAttachVolumeRequest,
  zCreateVolumeRequest,
  zListScope,
  zListVolumesQuery,
  zPatchVolumeRequest,
} from '@nyabase/common';
import { CurrentActor } from '../iam/decorators/current-actor.decorator.js';
import type { Actor } from '../iam/actor.js';
import { LocalVolumesService } from './local-volumes.service.js';
import { VolumeAttachmentsService } from './volume-attachments.service.js';

/** Local volumes: owners and `ManageVolumes` holders share one surface. */
@Controller('volumes')
export class VolumesController {
  constructor(private readonly service: LocalVolumesService) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query() query: Record<string, unknown>) {
    return this.service.list(actor, zListVolumesQuery.parse(query));
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.service.get(actor, id);
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const kind = (body as { scope?: { kind?: string } } | null)?.scope?.kind;
    if (kind === 'shared') {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'Shared volumes must be created via /shared-volumes',
      });
    }
    const input = zCreateVolumeRequest.parse(body);
    return this.service.create(actor, input);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.ACCEPTED)
  patch(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ) {
    return this.service.patch(actor, id, zPatchVolumeRequest.parse(body));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.ACCEPTED)
  delete(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.service.delete(actor, id);
  }
}

@Controller('servers/:serverId/storage-capacity')
export class StorageCapacityController {
  constructor(private readonly service: LocalVolumesService) {}

  /** `scope=mine` is the caller's grant view; `scope=all` is server-wide (`ManageServers`). */
  @Get()
  get(
    @Param('serverId') serverId: string,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    return this.service.capacity(actor, serverId, zListScope.parse(scope));
  }
}

@Controller('containers/:containerId/volumes')
export class ContainerVolumesController {
  constructor(private readonly service: VolumeAttachmentsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  attach(
    @Param('containerId') containerId: string,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ) {
    return this.service.attach(actor, containerId, zAttachVolumeRequest.parse(body), 'local');
  }

  @Delete(':attachmentId')
  @HttpCode(HttpStatus.ACCEPTED)
  detach(
    @Param('containerId') containerId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.service.detach(actor, attachmentId, containerId, 'local');
  }
}
