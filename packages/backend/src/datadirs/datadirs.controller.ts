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
import { UserEntity } from '../entities/user.entity.js';
import { z } from 'zod';

const zCreateDirRequest = z.object({
  serverId: z.string(),
  sourceKind: z.enum(['local', 'remote']),
  sourceId: z.string(),
  name: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/),
});

@Controller('data-dirs')
@UseGuards(JwtAuthGuard)
export class DataDirsController {
  constructor(
    private dataDirsService: DataDirsService,
    private accessResolver: AccessResolverService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: UserEntity,
    @Query('serverId') serverId: string,
    @Query('userId') _queryUserId?: string,
  ) {
    return this.dataDirsService.listDirs(user.id, serverId);
  }

  @Post()
  async create(@CurrentUser() user: UserEntity, @Body() body: unknown) {
    const dto = zCreateDirRequest.parse(body);
    const targetUserId = (body as { userId?: string }).userId ?? user.id;
    if (targetUserId !== user.id) throw new ForbiddenException();
    const ok = await this.accessResolver.hasMountSourceAccess(
      user.id, dto.serverId, dto.sourceKind, dto.sourceId,
    );
    if (!ok) throw new ForbiddenException('No access to this data source');
    return this.dataDirsService.createDir(user.id, user.id, dto.serverId, dto.sourceKind, dto.sourceId, dto.name, 1000);
  }

  @Delete(':serverId/:sourceId/:name')
  async delete(
    @Param('serverId') serverId: string,
    @Param('sourceId') sourceId: string,
    @Param('name') name: string,
    @CurrentUser() user: UserEntity,
    @Query('userId') _queryUserId?: string,
    @Query('sourceKind') sourceKind?: string,
  ) {
    if (sourceKind !== 'local' && sourceKind !== 'remote') {
      throw new BadRequestException(`sourceKind must be 'local' or 'remote'`);
    }
    const kind = sourceKind as 'local' | 'remote';
    const ok = await this.accessResolver.hasMountSourceAccess(user.id, serverId, kind, sourceId);
    if (!ok) throw new ForbiddenException('No access to this data source');
    return this.dataDirsService.deleteDir(user.id, user.id, serverId, kind, sourceId, name);
  }
}
