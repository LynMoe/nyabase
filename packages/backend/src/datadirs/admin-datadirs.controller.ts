import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  Query,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { DataDirReconcilerService } from './data-dir-reconciler.service.js';
import { DataDirsService } from './datadirs.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { UserEntity } from '../entities/user.entity.js';
import { Capability, zDataDirResourceName } from '@nyabase/common';
import { z } from 'zod';

const zResourceId = z.string().min(1).max(128);
const zAdminCreateDirRequest = z.object({
  serverId: zResourceId,
  sourceKind: z.enum(['local', 'remote']),
  sourceId: zResourceId,
  userId: zResourceId,
  name: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/),
}).strict();

@Controller('admin/data-dirs')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageContainersAny)
export class AdminDataDirsController {
  constructor(
    private reconcilerService: DataDirReconcilerService,
    private dataDirsService: DataDirsService,
    private accessResolver: AccessResolverService,
  ) {}

  /**
   * Returns dangling directories (orphans = FS only; missing = DB only)
   * filtered by optional sourceKind and sourceId.
   * Read-only — dangling dirs must be resolved manually on the server.
   */
  @Get('issues')
  async getIssues(
    @Query('sourceKind') sourceKind?: string,
    @Query('sourceId') sourceId?: string,
  ) {
    if (sourceKind && sourceKind !== 'local' && sourceKind !== 'remote') {
      throw new BadRequestException(`sourceKind must be 'local' or 'remote'`);
    }
    return this.reconcilerService.getIssues(sourceKind, sourceId);
  }

  @Get()
  async list(
    @CurrentUser() user: UserEntity,
    @Query('serverId') serverId: string,
    @Query('userId') targetUserId?: string,
  ) {
    return this.dataDirsService.listDirs(
      targetUserId ? zResourceId.parse(targetUserId) : user.id,
      zResourceId.parse(serverId),
    );
  }

  @Post()
  async create(@CurrentUser() user: UserEntity, @Body() body: unknown) {
    const dto = zAdminCreateDirRequest.parse(body);
    await this.requireTargetMountAccess(dto.userId, dto.serverId, dto.sourceKind, dto.sourceId);
    return this.dataDirsService.createDir(
      user.id,
      dto.userId,
      dto.serverId,
      dto.sourceKind,
      dto.sourceId,
      dto.name,
      1000,
      'admin',
    );
  }

  @Delete(':serverId/:sourceId/:name')
  async delete(
    @Param('serverId') serverId: string,
    @Param('sourceId') sourceId: string,
    @Param('name') name: string,
    @CurrentUser() user: UserEntity,
    @Query('userId') targetUserId?: string,
    @Query('sourceKind') sourceKind?: string,
  ) {
    if (!targetUserId) throw new BadRequestException('userId is required');
    if (sourceKind !== 'local' && sourceKind !== 'remote') {
      throw new BadRequestException(`sourceKind must be 'local' or 'remote'`);
    }
    const safeName = zDataDirResourceName.parse(name);
    const safeServerId = zResourceId.parse(serverId);
    const safeSourceId = zResourceId.parse(sourceId);
    const safeTargetUserId = zResourceId.parse(targetUserId);
    const kind = sourceKind as 'local' | 'remote';
    return this.dataDirsService.deleteDir(
      user.id, safeTargetUserId, safeServerId, kind, safeSourceId, safeName, 'admin',
    );
  }

  private async requireTargetMountAccess(
    targetUserId: string,
    serverId: string,
    sourceKind: 'local' | 'remote',
    sourceId: string,
  ) {
    const ok = await this.accessResolver.hasMountSourceAccess(targetUserId, serverId, sourceKind, sourceId);
    if (!ok) throw new ForbiddenException('Target user has no access to this data source');
  }
}
