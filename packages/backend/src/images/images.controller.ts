import {
  Controller, Get, Param,
  UseGuards, Query, ForbiddenException,
} from '@nestjs/common';
import { ImagesService } from './images.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { AccessResolverService } from '../access/access-resolver.service.js';

@Controller('images')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class ImagesController {
  constructor(
    private imagesService: ImagesService,
    private accessResolver: AccessResolverService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: UserRecord,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.imagesService.findAccessibleForUser(user.id, activeOnly === 'true');
  }

  @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user: UserRecord) {
    const image = await this.imagesService.findById(id);
    const accessible = await this.accessResolver.isImageAccessibleForUser(user.id, image.id);
    if (!accessible) throw new ForbiddenException();
    if (image.deleting) throw new ForbiddenException();
    return this.imagesService.toDto(image);
  }
}
