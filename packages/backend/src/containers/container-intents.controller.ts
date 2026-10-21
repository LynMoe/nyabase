import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { RequireCaps } from '../iam/decorators/require-caps.decorator.js';
import { CurrentUser } from '../iam/decorators/current-user.decorator.js';
import type { UserRecord } from '../iam/user-record.js';
import { listOptions, toDto } from '../reconcile/intent-dto.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { ContainerControlRepository } from './container-control.repository.js';

@Controller('containers/:containerId/intents')
export class ContainerIntentsController {
  constructor(
    private readonly intents: IntentRepository,
    private readonly containers: ContainerControlRepository,
  ) {}

  @Get()
  async list(
    @Param('containerId') containerId: string,
    @CurrentUser() user: UserRecord,
    @Query() query: Record<string, unknown>,
  ) {
    const ownerId = await this.containers.findOwnerId(containerId);
    if (ownerId !== user.id) {
      throw new NotFoundException('Container not found');
    }
    const page = await this.intents.list({
      ...listOptions(query),
      resourceId: containerId,
      resourceType: 'container',
    });
    return {
      items: page.items.map(toDto),
      nextCursor: page.nextCursor,
    };
  }
}

@Controller('admin/containers/:containerId/intents')
@RequireCaps(Capability.ManageContainersAny)
export class AdminContainerIntentsController {
  constructor(private readonly intents: IntentRepository) {}

  @Get()
  async list(
    @Param('containerId') containerId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const page = await this.intents.list({
      ...listOptions(query),
      resourceId: containerId,
      resourceType: 'container',
    });
    return {
      items: page.items.map(toDto),
      nextCursor: page.nextCursor,
    };
  }
}
