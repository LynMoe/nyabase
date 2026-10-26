import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  zSshSessionListQuery,
  zSshSessionStatsQuery,
  type CursorPaginatedResponse,
  type SshSessionDetailDto,
  type SshSessionDto,
  type SshSessionStatsDto,
} from '@nyabase/common';
import { CurrentActor } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { SshSessionsService } from './ssh-sessions.service.js';

/**
 * SSH proxy connection history. `scope=mine` (the default) is the caller's
 * own connections; `scope=all` needs the user admin role.
 */
@Controller('ssh-sessions')
export class SshSessionsController {
  constructor(private readonly sessions: SshSessionsService) {}

  @Get()
  list(
    @CurrentActor() actor: Actor,
    @Query() query: Record<string, unknown>,
  ): Promise<CursorPaginatedResponse<SshSessionDto>> {
    return this.sessions.list(actor, zSshSessionListQuery.parse(query));
  }

  @Get('stats')
  stats(@CurrentActor() actor: Actor, @Query() query: Record<string, unknown>): Promise<SshSessionStatsDto> {
    return this.sessions.stats(actor, zSshSessionStatsQuery.parse(query));
  }

  @Get(':sessionId')
  detail(
    @CurrentActor() actor: Actor,
    @Param('sessionId') sessionId: string,
    @Query('scope') scope?: string,
  ): Promise<SshSessionDetailDto> {
    return this.sessions.detail(actor, sessionId, scope);
  }
}
