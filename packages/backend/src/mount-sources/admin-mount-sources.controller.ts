import {
  Controller,
  Get,
  Post,
  Delete,
  Query,
  Body,
  Param,
  UseGuards,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { MountSourcesService } from './mount-sources.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { UserEntity } from '../entities/user.entity.js';
import { Capability } from '@nyabase/common';
import { z } from 'zod';
import { parseMountSourceGrantTarget } from './mount-source-grant-target.js';

const zGrantBody = z.object({
  scope: z.enum(['user', 'group']),
  scopeId: z.string().min(1),
  serverId: z.string().min(1).optional(),
}).strict();

@Controller('admin/mount-sources')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AdminMountSourcesController {
  constructor(private mountSourcesService: MountSourcesService) {}

  @Get('grants')
  @RequireCaps(Capability.ManageGrants)
  async listGrants(
    @Query('sourceKind') sourceKind: string,
    @Query('sourceId') sourceId: string,
    @Query('serverId') serverId: string | undefined,
  ) {
    if (!sourceKind || !sourceId) throw new BadRequestException('sourceKind and sourceId are required');
    return this.mountSourcesService.listGrantsForSource(
      parseMountSourceGrantTarget(sourceKind, sourceId, serverId),
    );
  }

  @Post('grants/:sourceKind/:sourceId')
  @RequireCaps(Capability.ManageGrants)
  async upsertGrant(
    @Param('sourceKind') sourceKind: string,
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
    @CurrentUser() actor: UserEntity,
  ) {
    const { scope, scopeId, serverId } = zGrantBody.parse(body);
    return this.mountSourcesService.upsertGrant(
      actor.id,
      scope,
      scopeId,
      parseMountSourceGrantTarget(sourceKind, sourceId, serverId),
    );
  }

  @Delete('grants/:sourceKind/:sourceId/:scope/:scopeId')
  @RequireCaps(Capability.ManageGrants)
  @HttpCode(204)
  async deleteGrant(
    @Param('sourceKind') sourceKind: string,
    @Param('sourceId') sourceId: string,
    @Param('scope') scope: string,
    @Param('scopeId') scopeId: string,
    @Query('serverId') serverId: string | undefined,
    @CurrentUser() actor: UserEntity,
  ) {
    const parsedScope = z.enum(['user', 'group']).parse(scope);
    await this.mountSourcesService.deleteGrant(
      actor.id,
      parsedScope,
      scopeId,
      parseMountSourceGrantTarget(sourceKind, sourceId, serverId),
    );
  }
}
