import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  zCreateGrantBundleRequest,
  zPatchGrantBundleRequest,
  zPreviewGrantBundleRequest,
  zResourceIdentity,
  Role,
} from '@nyabase/common';
import { CurrentActor, RequireRole } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { GrantBundlesService } from './grant-bundles.service.js';

@Controller('admin/grant-bundles')
@RequireRole(Role.UserAdmin)
export class GrantBundlesController {
  constructor(private readonly bundles: GrantBundlesService) {}

  @Get()
  list(@Query('serverId') serverId?: string) {
    return this.bundles.list(serverId === undefined ? undefined : zResourceIdentity.parse(serverId));
  }

  @Post()
  create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.bundles.create(actor, zCreateGrantBundleRequest.parse(body));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.bundles.get(id);
  }

  @Post(':id/preview')
  preview(@Param('id') id: string, @Body() body: unknown) {
    return this.bundles.preview(id, zPreviewGrantBundleRequest.parse(body));
  }

  @Patch(':id')
  patch(@Param('id') id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.bundles.update(actor, id, zPatchGrantBundleRequest.parse(body));
  }

  @Delete(':id')
  delete(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.bundles.delete(actor, id);
  }
}
