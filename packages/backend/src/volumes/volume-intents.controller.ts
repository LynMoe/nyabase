import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { RequireCaps } from '../iam/decorators/require-caps.decorator.js';
import { CurrentUser } from '../iam/decorators/current-user.decorator.js';
import type { UserRecord } from '../iam/user-record.js';
import { listOptions, toDto } from '../reconcile/intent-dto.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { VolumesRepository } from './volumes.repository.js';

@Controller('volumes/:volumeId/intents')
export class VolumeIntentsController {
  constructor(
    private readonly intents: IntentRepository,
    private readonly volumes: VolumesRepository,
  ) {}

  @Get()
  async list(
    @Param('volumeId') volumeId: string,
    @CurrentUser() user: UserRecord,
    @Query() query: Record<string, unknown>,
  ) {
    const volume = await this.volumes.findOwnership(volumeId);
    if (!volume || volume.ownerId !== user.id || volume.shared) {
      throw new NotFoundException('Volume not found');
    }
    const page = await this.intents.listForResource('volume', volumeId, listOptions(query));
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }
}

@Controller('shared-volumes/:volumeId/intents')
export class SharedVolumeIntentsController {
  constructor(
    private readonly intents: IntentRepository,
    private readonly volumes: VolumesRepository,
  ) {}

  @Get()
  async list(
    @Param('volumeId') volumeId: string,
    @CurrentUser() user: UserRecord,
    @Query() query: Record<string, unknown>,
  ) {
    const volume = await this.volumes.findOwnership(volumeId);
    if (!volume || volume.ownerId !== user.id || !volume.shared) {
      throw new NotFoundException('Volume not found');
    }
    const page = await this.intents.listForResource('volume', volumeId, listOptions(query));
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }
}

@Controller('admin/volumes/:volumeId/intents')
@RequireCaps(Capability.ManageVolumes)
export class AdminVolumeIntentsController {
  constructor(
    private readonly intents: IntentRepository,
    private readonly volumes: VolumesRepository,
  ) {}

  @Get()
  async list(
    @Param('volumeId') volumeId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const volume = await this.volumes.findOwnership(volumeId);
    if (!volume || volume.shared) {
      throw new NotFoundException('Volume not found');
    }
    const page = await this.intents.listForResource('volume', volumeId, listOptions(query));
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }
}

@Controller('admin/shared-volumes/:volumeId/intents')
@RequireCaps(Capability.ManageSharedVolumes)
export class AdminSharedVolumeIntentsController {
  constructor(
    private readonly intents: IntentRepository,
    private readonly volumes: VolumesRepository,
  ) {}

  @Get()
  async list(
    @Param('volumeId') volumeId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const volume = await this.volumes.findOwnership(volumeId);
    if (!volume || !volume.shared) {
      throw new NotFoundException('Volume not found');
    }
    const page = await this.intents.listForResource('volume', volumeId, listOptions(query));
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }
}
