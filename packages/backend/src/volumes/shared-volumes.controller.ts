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
  UseGuards,
} from '@nestjs/common';
import {
  Capability,
  zAttachVolumeRequest,
  zCreateSharedVolumeRequest,
  zListSharedVolumesQuery,
  zPatchVolumeRequest,
} from '@nyabase/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { isIntentAccepted, VolumesService } from './volumes.service.js';

@Controller('shared-volumes')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class SharedVolumesController {
  constructor(private readonly service: VolumesService) {}

  @Get()
  list(@CurrentUser() user: UserRecord, @Query() query: Record<string, unknown>) {
    const parsed = zListSharedVolumesQuery.parse(query);
    return this.service.listSharedForUser(user.id, parsed.attachableOnServerId);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: UserRecord) {
    return this.service.getSharedForUser(id, user.id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: UserRecord, @Body() body: unknown) {
    const input = zCreateSharedVolumeRequest.parse(body);
    return this.service.createSharedForUser(user.id, input);
  }

  @Patch(':id')
  async patch(
    @Param('id') id: string,
    @CurrentUser() user: UserRecord,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { status: (code: number) => void },
  ) {
    const result = await this.service.patchSharedForUser(
      user.id,
      id,
      zPatchVolumeRequest.parse(body),
    );
    if (isIntentAccepted(result)) response.status(HttpStatus.ACCEPTED);
    return result;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.ACCEPTED)
  delete(@Param('id') id: string, @CurrentUser() user: UserRecord) {
    return this.service.deleteSharedForUser(user.id, id);
  }
}

@Controller('admin/shared-volumes')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageSharedVolumes)
export class AdminSharedVolumesController {
  constructor(private readonly service: VolumesService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    const parsed = zListSharedVolumesQuery.parse(query);
    return this.service.listSharedForAdmin(parsed.attachableOnServerId);
  }

  @Get(':id/catalogs')
  inspect(@Param('id') id: string) {
    return this.service.inspectSharedVolumeCatalogs(id);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.getSharedForAdmin(id);
  }

  @Patch(':id')
  async patch(
    @Param('id') id: string,
    @CurrentUser() user: UserRecord,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { status: (code: number) => void },
  ) {
    const result = await this.service.patchSharedForAdmin(
      user.id,
      id,
      zPatchVolumeRequest.parse(body),
    );
    if (isIntentAccepted(result)) response.status(HttpStatus.ACCEPTED);
    return result;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.ACCEPTED)
  delete(@Param('id') id: string, @CurrentUser() user: UserRecord) {
    return this.service.deleteSharedForAdmin(user.id, id);
  }
}

@Controller('admin/shared-backends')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageSharedVolumes)
export class AdminSharedBackendCatalogInspectController {
  constructor(private readonly service: VolumesService) {}

  @Get(':id/catalog-inspect')
  inspect(@Param('id') id: string) {
    return this.service.inspectSharedBackendCatalogs(id);
  }
}

@Controller('containers/:containerId/shared-volumes')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class ContainerSharedVolumesController {
  constructor(private readonly service: VolumesService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  attach(
    @Param('containerId') containerId: string,
    @CurrentUser() user: UserRecord,
    @Body() body: unknown,
  ) {
    return this.service.attachForUser(
      user.id,
      containerId,
      zAttachVolumeRequest.parse(body),
      'shared',
    );
  }

  @Delete(':attachmentId')
  @HttpCode(HttpStatus.ACCEPTED)
  detach(
    @Param('containerId') containerId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: UserRecord,
  ) {
    return this.service.detachForUser(user.id, attachmentId, containerId, 'shared');
  }
}

@Controller('admin/containers/:containerId/shared-volumes')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageSharedVolumes)
export class AdminContainerSharedVolumesController {
  constructor(private readonly service: VolumesService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  attach(
    @Param('containerId') containerId: string,
    @CurrentUser() user: UserRecord,
    @Body() body: unknown,
  ) {
    return this.service.attachForAdmin(
      user.id,
      containerId,
      zAttachVolumeRequest.parse(body),
      'shared',
    );
  }

  @Delete(':attachmentId')
  @HttpCode(HttpStatus.ACCEPTED)
  detach(
    @Param('containerId') containerId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: UserRecord,
  ) {
    return this.service.detachForAdmin(user.id, attachmentId, containerId, 'shared');
  }
}
