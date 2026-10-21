import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { RequireCaps } from '../iam/decorators/require-caps.decorator.js';
import { listOptions, toDto } from '../reconcile/intent-dto.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { ImagesService } from './images.service.js';

@Controller('admin/images/:imageId/assignments/:serverId/intents')
@RequireCaps(Capability.ManageImages)
export class AdminImageAssignmentIntentsController {
  constructor(
    private readonly intents: IntentRepository,
    private readonly images: ImagesService,
  ) {}

  @Get()
  async list(
    @Param('imageId') imageId: string,
    @Param('serverId') serverId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const assignmentId = await this.images.findAssignmentId(imageId, serverId);
    if (!assignmentId) throw new NotFoundException('Image assignment not found');
    const page = await this.intents.listForResource(
      'image_assignment',
      assignmentId,
      listOptions(query),
    );
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }
}

@Controller('admin/images/:imageId/intents')
@RequireCaps(Capability.ManageImages)
export class AdminImageIntentsController {
  constructor(
    private readonly intents: IntentRepository,
    private readonly images: ImagesService,
  ) {}

  @Get()
  async list(
    @Param('imageId') imageId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const options = listOptions(query);
    const assignmentIds = await this.images.listAssignmentIds(imageId);
    if (assignmentIds.length === 0) {
      return { items: [], nextCursor: null };
    }
    const page = await this.intents.list({
      ...options,
      resourceType: 'image_assignment',
      resourceIds: assignmentIds,
    });
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }
}
