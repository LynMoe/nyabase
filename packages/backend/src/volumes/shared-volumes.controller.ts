import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  Capability,
  zAttachVolumeRequest,
  zCreateSharedVolumeRequest,
  zListSharedVolumesQuery,
  zPatchVolumeRequest,
} from '@nyabase/common';
import { RequireCaps } from '../iam/decorators/require-caps.decorator.js';
import { CurrentActor } from '../iam/decorators/current-actor.decorator.js';
import type { Actor } from '../iam/actor.js';
import { SharedVolumeCatalogInspectService } from './shared-volume-catalog.service.js';
import { SharedVolumesService } from './shared-volumes.service.js';
import { VolumeAttachmentsService } from './volume-attachments.service.js';
import { isIntentAccepted } from './volume-dtos.js';

/** Shared volumes: owners and `ManageSharedVolumes` holders share one surface. */
@Controller('shared-volumes')
export class SharedVolumesController {
  constructor(
    private readonly service: SharedVolumesService,
    private readonly inspector: SharedVolumeCatalogInspectService,
  ) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query() query: Record<string, unknown>) {
    return this.service.list(actor, zListSharedVolumesQuery.parse(query));
  }

  @Get(':id/catalogs')
  @RequireCaps(Capability.ManageSharedVolumes)
  inspect(@Param('id') id: string) {
    return this.inspector.inspectSharedVolumeCatalogs(id);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.service.get(actor, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = zCreateSharedVolumeRequest.parse(body);
    return this.service.create(actor, input);
  }

  @Patch(':id')
  async patch(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { status: (code: number) => void },
  ) {
    const result = await this.service.patch(actor, id, zPatchVolumeRequest.parse(body));
    if (isIntentAccepted(result)) response.status(HttpStatus.ACCEPTED);
    return result;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.ACCEPTED)
  delete(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.service.delete(actor, id);
  }
}

@Controller('shared-backends')
export class SharedBackendCatalogInspectController {
  constructor(private readonly inspector: SharedVolumeCatalogInspectService) {}

  @Get(':id/catalog-inspect')
  @RequireCaps(Capability.ManageSharedVolumes)
  inspect(@Param('id') id: string) {
    return this.inspector.inspectSharedBackendCatalogs(id);
  }
}

@Controller('containers/:containerId/shared-volumes')
export class ContainerSharedVolumesController {
  constructor(private readonly service: VolumeAttachmentsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  attach(
    @Param('containerId') containerId: string,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ) {
    return this.service.attach(actor, containerId, zAttachVolumeRequest.parse(body), 'shared');
  }

  @Delete(':attachmentId')
  @HttpCode(HttpStatus.ACCEPTED)
  detach(
    @Param('containerId') containerId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.service.detach(actor, attachmentId, containerId, 'shared');
  }
}
