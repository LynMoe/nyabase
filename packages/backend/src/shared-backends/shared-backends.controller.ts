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
  zCreateSharedBackendRequest,
  zDiscoverSharedExecutorsRequest,
  zListScope,
  zPatchSharedBackendExecutorRequest,
  zPatchSharedBackendRequest,
  Role,
} from '@nyabase/common';
import { RequireRole, CurrentActor } from '../iam/decorators.js';
import { requireUserId, type Actor } from '../iam/actor.js';
import { SharedBackendsService } from './shared-backends.service.js';

/**
 * Shared backends: `scope=mine` (default) lists the granted ones;
 * `scope=all` lists every backend for user admins (executor details for admins);
 * `scope=all` detail, executors and every mutation are admin-only.
 */
@Controller('shared-backends')
export class SharedBackendsController {
  constructor(private readonly service: SharedBackendsService) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query('scope') scope?: string) {
    return this.service.list(actor, zListScope.parse(scope));
  }

  @Get(':id/executors')
  @RequireRole(Role.Admin)
  listExecutors(@Param('id') id: string) {
    return this.service.listExecutors(id);
  }

  @Post(':id/executors/discover')
  @RequireRole(Role.Admin)
  @HttpCode(200)
  discoverExecutors(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const input = zDiscoverSharedExecutorsRequest.parse(body ?? {});
    return this.service.discoverExecutors(requireUserId(actor), id, input.serverId);
  }

  @Patch(':id/executors/:executorId')
  @RequireRole(Role.Admin)
  patchExecutor(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Param('executorId') executorId: string,
    @Body() body: unknown,
  ) {
    return this.service.patchExecutor(
      requireUserId(actor),
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
  @RequireRole(Role.Admin)
  create(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.service.create(requireUserId(actor), zCreateSharedBackendRequest.parse(body));
  }

  @Patch(':id')
  @RequireRole(Role.Admin)
  patch(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.service.patch(requireUserId(actor), id, zPatchSharedBackendRequest.parse(body));
  }

  @Delete(':id')
  @RequireRole(Role.Admin)
  @HttpCode(204)
  async delete(@CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.service.delete(requireUserId(actor), id);
  }
}
