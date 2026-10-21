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
  Capability,
  FailureCode,
  zAttachVolumeRequest,
  zCreateVolumeRequest,
  zListVolumesQuery,
  zPatchVolumeRequest,
} from '@nyabase/common';
import { RequireCaps } from '../iam/decorators/require-caps.decorator.js';
import { CurrentUser } from '../iam/decorators/current-user.decorator.js';
import type { UserRecord } from '../iam/user-record.js';
import { VolumesService } from './volumes.service.js';

@Controller('volumes')
export class VolumesController {
  constructor(private readonly service: VolumesService) {}

  @Get()
  list(@CurrentUser() user: UserRecord) {
    return this.service.listForUser(user.id);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: UserRecord) {
    return this.service.getForUser(id, user.id);
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(@CurrentUser() user: UserRecord, @Body() body: unknown) {
    const kind = (body as { scope?: { kind?: string } } | null)?.scope?.kind;
    if (kind === 'shared') {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'Shared volumes must be created via /shared-volumes',
      });
    }
    const input = zCreateVolumeRequest.parse(body);
    return this.service.createForUser(user.id, input);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.ACCEPTED)
  patch(
    @Param('id') id: string,
    @CurrentUser() user: UserRecord,
    @Body() body: unknown,
  ) {
    return this.service.patchForUser(user.id, id, zPatchVolumeRequest.parse(body));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.ACCEPTED)
  delete(@Param('id') id: string, @CurrentUser() user: UserRecord) {
    return this.service.deleteForUser(user.id, id);
  }
}

@Controller('servers/:serverId/storage-capacity')
export class StorageCapacityController {
  constructor(private readonly service: VolumesService) {}

  @Get()
  get(@Param('serverId') serverId: string, @CurrentUser() user: UserRecord) {
    return this.service.capacityForUser(user.id, serverId);
  }
}

@Controller('containers/:containerId/volumes')
export class ContainerVolumesController {
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
      'local',
    );
  }

  @Delete(':attachmentId')
  @HttpCode(HttpStatus.ACCEPTED)
  detach(
    @Param('containerId') containerId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: UserRecord,
  ) {
    return this.service.detachForUser(user.id, attachmentId, containerId, 'local');
  }
}

@Controller('admin/containers/:containerId/volumes')
@RequireCaps(Capability.ManageVolumes)
export class AdminContainerVolumesController {
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
      'local',
    );
  }

  @Delete(':attachmentId')
  @HttpCode(HttpStatus.ACCEPTED)
  detach(
    @Param('containerId') containerId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: UserRecord,
  ) {
    return this.service.detachForAdmin(user.id, attachmentId, containerId, 'local');
  }
}

@Controller('admin/volumes')
@RequireCaps(Capability.ManageVolumes)
export class AdminVolumesController {
  constructor(private readonly service: VolumesService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    const parsed = zListVolumesQuery.parse(query);
    return this.service.listForAdmin(parsed.serverId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.getForAdmin(id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.ACCEPTED)
  patch(@Param('id') id: string, @CurrentUser() user: UserRecord, @Body() body: unknown) {
    return this.service.patchForAdmin(user.id, id, zPatchVolumeRequest.parse(body));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.ACCEPTED)
  delete(@Param('id') id: string, @CurrentUser() user: UserRecord) {
    return this.service.deleteForAdmin(user.id, id);
  }
}
