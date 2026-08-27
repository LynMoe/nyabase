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
  UseGuards,
} from '@nestjs/common';
import {
  Capability,
  FailureCode,
  zAttachVolumeRequest,
  zCreateVolumeRequest,
  zPatchVolumeRequest,
} from '@nyabase/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { VolumesService } from './volumes.service.js';

@Controller('volumes')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
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
    const input = zCreateVolumeRequest.parse(body);
    if (input.ownerId) {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'User volume creation cannot specify ownerId',
      });
    }
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
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class StorageCapacityController {
  constructor(private readonly service: VolumesService) {}

  @Get()
  get(@Param('serverId') serverId: string, @CurrentUser() user: UserRecord) {
    return this.service.capacityForUser(user.id, serverId);
  }
}

@Controller('containers/:containerId/volumes')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class ContainerVolumesController {
  constructor(private readonly service: VolumesService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  attach(
    @Param('containerId') containerId: string,
    @CurrentUser() user: UserRecord,
    @Body() body: unknown,
  ) {
    return this.service.attachForUser(user.id, containerId, zAttachVolumeRequest.parse(body));
  }

  @Delete(':attachmentId')
  @HttpCode(HttpStatus.ACCEPTED)
  detach(
    @Param('containerId') containerId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: UserRecord,
  ) {
    return this.service.detachForUser(user.id, attachmentId, containerId);
  }
}

@Controller('admin/containers/:containerId/volumes')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
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
    return this.service.attachForAdmin(user.id, containerId, zAttachVolumeRequest.parse(body));
  }

  @Delete(':attachmentId')
  @HttpCode(HttpStatus.ACCEPTED)
  detach(
    @Param('containerId') containerId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: UserRecord,
  ) {
    return this.service.detachForAdmin(user.id, attachmentId, containerId);
  }
}

@Controller('admin/volumes')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageVolumes)
export class AdminVolumesController {
  constructor(private readonly service: VolumesService) {}

  @Get()
  list() {
    return this.service.listForAdmin();
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(@CurrentUser() user: UserRecord, @Body() body: unknown) {
    const input = zCreateVolumeRequest.parse(body);
    if (!input.ownerId) {
      throw new BadRequestException('Admin volume creation requires ownerId');
    }
    return this.service.createForAdmin(user.id, { ...input, ownerId: input.ownerId });
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
