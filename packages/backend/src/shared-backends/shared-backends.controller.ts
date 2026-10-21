import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  Capability,
  zCreateSharedBackendRequest,
  zDiscoverSharedExecutorsRequest,
  zListScope,
  zPatchSharedBackendExecutorRequest,
  zPatchSharedBackendRequest,
} from '@nyabase/common';
import { RequireCaps, CurrentActor } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { SharedBackendsService } from './shared-backends.service.js';

/**
 * Shared backends: `scope=mine` (default) lists the granted ones;
 * `scope=all`, executors and every mutation are `ManageSharedBackends`.
 */
@Controller('shared-backends')
export class SharedBackendsController {
  constructor(private readonly service: SharedBackendsService) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query('scope') scope?: string) {
    return this.service.list(actor, zListScope.parse(scope));
  }

  @Get(':id/executors')
  @RequireCaps(Capability.ManageSharedBackends)
  listExecutors(@Param('id') id: string) {
    return this.service.listExecutors(id);
  }

  @Post(':id/executors/discover')
  @RequireCaps(Capability.ManageSharedBackends)
  @HttpCode(200)
  discoverExecutors(@Param('id') id: string, @Body() body: unknown) {
    const input = zDiscoverSharedExecutorsRequest.parse(body ?? {});
    return this.service.discoverExecutors(id, input.serverId);
  }

  @Patch(':id/executors/:executorId')
  @RequireCaps(Capability.ManageSharedBackends)
  patchExecutor(
    @Param('id') id: string,
    @Param('executorId') executorId: string,
    @Body() body: unknown,
  ) {
    return this.service.patchExecutor(
      id,
      executorId,
      zPatchSharedBackendExecutorRequest.parse(body),
    );
  }

  @Get(':id')
  get(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    return this.service.get(actor, id, zListScope.parse(scope));
  }

  @Post()
  @RequireCaps(Capability.ManageSharedBackends)
  create(@Body() body: unknown) {
    return this.service.create(zCreateSharedBackendRequest.parse(body));
  }

  @Patch(':id')
  @RequireCaps(Capability.ManageSharedBackends)
  patch(@Param('id') id: string, @Body() body: unknown) {
    return this.service.patch(id, zPatchSharedBackendRequest.parse(body));
  }

  @Delete(':id')
  @RequireCaps(Capability.ManageSharedBackends)
  @HttpCode(204)
  async delete(@Param('id') id: string) {
    await this.service.delete(id);
  }
}
