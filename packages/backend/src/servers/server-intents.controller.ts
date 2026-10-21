import { Controller, Get, Param, Query } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { RequireCaps } from '../iam/decorators/require-caps.decorator.js';
import { listOptions, toDto } from '../reconcile/intent-dto.js';
import { IntentRepository } from '../reconcile/intent.repository.js';

@Controller('admin/servers/:serverId/intents')
@RequireCaps(Capability.ManageServers)
export class AdminServerIntentsController {
  constructor(private readonly intents: IntentRepository) {}

  @Get()
  async list(
    @Param('serverId') serverId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const parsed = listOptions(query);
    const page = await this.intents.list({ ...parsed, serverId });
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }
}
