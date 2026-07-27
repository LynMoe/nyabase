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
import { DataDirsService } from './datadirs.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import type { UserRecord } from '../domain/domain-records.js';
import { zCreateDataDirRequest, zDataDirResourceName } from '@nyabase/common';
import { z } from 'zod';

const zResourceId = z.string().min(1).max(128);

@Controller('data-dirs')
@UseGuards(JwtAuthGuard)
export class DataDirsController {
  constructor(
    private dataDirsService: DataDirsService,
    private accessResolver: AccessResolverService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: UserRecord,
    @Query('serverId') serverId: string,
    @Query('userId') _queryUserId?: string,
  ) {
    const safeServerId = zResourceId.parse(serverId);
    return this.accessResolver.runWithActiveServerAccess(
      user.id,
      safeServerId,
      async () => this.dataDirsService.listUserDirs(user.id, safeServerId),
    );
  }

  @Post()
  async create(@CurrentUser() user: UserRecord, @Body() body: unknown) {
    const dto = zCreateDataDirRequest.parse(body);
    const ok = await this.accessResolver.hasMountSourceAccess(
      user.id, dto.serverId, dto.sourceKind, dto.sourceId,
    );
    if (!ok) throw new ForbiddenException('No access to this data source');
    const created = await this.dataDirsService.createDir(
      user.id,
      user.id,
      dto.serverId,
      dto.sourceKind,
      dto.sourceId,
      dto.name,
      1000,
    );
    // Field-by-field ordinary projection: future physical service fields must
    // not silently become part of the requester response.
    return {
      id: created.id,
      resourceId: created.resourceId,
      serverId: created.serverId,
      sourceKind: created.sourceKind,
      sourceId: created.sourceId,
      name: created.name,
      taskId: created.taskId,
    };
  }

  @Delete(':serverId/:sourceId/:name')
  async delete(
    @Param('serverId') serverId: string,
    @Param('sourceId') sourceId: string,
    @Param('name') name: string,
    @CurrentUser() user: UserRecord,
    @Query('userId') _queryUserId?: string,
    @Query('sourceKind') sourceKind?: string,
  ) {
    if (sourceKind !== 'local' && sourceKind !== 'remote') {
      throw new BadRequestException(`sourceKind must be 'local' or 'remote'`);
    }
    const safeName = zDataDirResourceName.parse(name);
    const safeServerId = zResourceId.parse(serverId);
    const safeSourceId = zResourceId.parse(sourceId);
    const kind = sourceKind as 'local' | 'remote';
    const ok = await this.accessResolver.hasMountSourceAccess(user.id, safeServerId, kind, safeSourceId);
    if (!ok) throw new ForbiddenException('No access to this data source');
    return this.dataDirsService.deleteDir(
      user.id, user.id, safeServerId, kind, safeSourceId, safeName,
    );
  }
}
