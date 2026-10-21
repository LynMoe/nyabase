import {
  Controller, Get, Param,
  Query, ForbiddenException,
} from '@nestjs/common';
import { ImagesService } from './images.service.js';
import { CurrentUser } from '../iam/decorators/current-user.decorator.js';
import type { UserRecord } from '../iam/user-record.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';

@Controller('images')
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
