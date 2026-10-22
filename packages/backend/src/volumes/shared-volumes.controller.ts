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
  zAttachVolumeRequest,
  zCreateSharedVolumeRequest,
  zListScope,
  zListSharedVolumesQuery,
  zPatchVolumeRequest,
  Role,
} from '@nyabase/common';
import { RequireRole, CurrentActor } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { SharedVolumeCatalogInspectService } from './shared-volume-catalog.service.js';
import { SharedVolumesService } from './shared-volumes.service.js';
import { VolumeAttachmentsService } from './volume-attachments.service.js';
import { isIntentAccepted } from './volume-dtos.js';

/** Shared volumes: owners and admins share one surface; admins act on others' rows with `?scope=all`. */
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
  @RequireRole(Role.Admin)
  inspect(@Param('id') id: string) {
    return this.inspector.inspectSharedVolumeCatalogs(id);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentActor() actor: Actor, @Query('scope') scope?: string) {
    return this.service.get(actor, id, zListScope.parse(scope));
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
    @Query('scope') scope?: string,
  ) {
    const result = await this.service.patch(
      actor,
      id,
      zPatchVolumeRequest.parse(body),
      zListScope.parse(scope),
    );
    if (isIntentAccepted(result)) response.status(HttpStatus.ACCEPTED);
    return result;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.ACCEPTED)
  delete(@Param('id') id: string, @CurrentActor() actor: Actor, @Query('scope') scope?: string) {
    return this.service.delete(actor, id, zListScope.parse(scope));
  }
}

@Controller('shared-backends')
export class SharedBackendCatalogInspectController {
  constructor(private readonly inspector: SharedVolumeCatalogInspectService) {}

  @Get(':id/catalog-inspect')
  @RequireRole(Role.Admin)
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
    @Query('scope') scope?: string,
  ) {
    return this.service.attach(
      actor,
      containerId,
      zAttachVolumeRequest.parse(body),
      'shared',
      zListScope.parse(scope),
    );
  }

  @Delete(':attachmentId')
  @HttpCode(HttpStatus.ACCEPTED)
  detach(
    @Param('containerId') containerId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    return this.service.detach(actor, attachmentId, containerId, 'shared', zListScope.parse(scope));
  }
}
