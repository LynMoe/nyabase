import {
  Controller, Get, Post, Patch, Delete, Param,
  Body, UseGuards, Query, HttpCode,
} from '@nestjs/common';
import { ImagesService } from './images.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import {
  Capability,
  zCreateImageRequest,
  zPullImageRequest,
  zUpdateAdminImageRequest,
} from '@nyabase/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { UserEntity } from '../entities/user.entity.js';

@Controller('admin/images')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AdminImagesController {
  constructor(
    private imagesService: ImagesService,
  ) {}

  @Get()
  @RequireCaps(Capability.ManageImages)
  async list(@Query('activeOnly') activeOnly?: string) {
    return this.imagesService.findAllAdmin(activeOnly === 'true');
  }

  @Post()
  @RequireCaps(Capability.ManageImages)
  async create(@Body() body: unknown, @CurrentUser() actor: UserEntity) {
    const dto = zCreateImageRequest.parse(body);
    return this.imagesService.create(actor.id, dto);
  }

  @Get(':id')
  @RequireCaps(Capability.ManageImages)
  async get(@Param('id') id: string) {
    return this.imagesService.findAdminDtoById(id);
  }

  @Get(':id/status')
  @RequireCaps(Capability.ManageImages)
  async getStatus(@Param('id') id: string) {
    const img = await this.imagesService.findById(id);
    return this.imagesService.getServerStatuses(img);
  }

  @Post(':id/pull')
  @RequireCaps(Capability.ManageImages)
  async pull(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() actor: UserEntity,
  ) {
    const dto = zPullImageRequest.parse(body);
    const img = await this.imagesService.findById(id);
    return this.imagesService.pullOnServers(actor.id, img, dto.serverIds);
  }

  @Patch(':id')
  @RequireCaps(Capability.ManageImages)
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() actor: UserEntity,
  ) {
    const { expectedRevision, ...dto } = zUpdateAdminImageRequest.parse(body);
    return this.imagesService.update(actor.id, id, dto, expectedRevision);
  }

  @Delete(':id')
  @RequireCaps(Capability.ManageImages)
  @HttpCode(202)
  async delete(@Param('id') id: string, @CurrentUser() actor: UserEntity) {
    return this.imagesService.delete(actor.id, id);
  }
}
