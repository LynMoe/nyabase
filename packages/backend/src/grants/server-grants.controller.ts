import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { Role, type ServerGrantDto, zListScope } from '@nyabase/common';
import { CurrentActor, RequireRole } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { GrantsService } from './grants.service.js';

/**
 * Every active or disabled user's server grants at once (`scope=all`, the
 * user list's server badges). One user's grants and every change stay under
 * `/users/:userId/server-grants`; there is no `scope=mine` here.
 */
@Controller('server-grants')
export class ServerGrantsController {
  constructor(private readonly grants: GrantsService) {}

  @Get()
  @RequireRole(Role.UserAdmin)
  list(@CurrentActor() actor: Actor, @Query('scope') scope?: string): Promise<ServerGrantDto[]> {
    if (zListScope.parse(scope) !== 'all') throw new BadRequestException('server-grants lists every user: pass scope=all');
    return this.grants.listAllServerGrants(actor);
  }
}
