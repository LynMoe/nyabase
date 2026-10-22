import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  Capability,
  zCreateServerRequest,
  zListScope,
  zPatchServerRequest,
  zRotateServerEnrollmentRequest,
  zRunPreflightRequest,
} from '@nyabase/common';
import { RequireCaps, CurrentActor } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { ServersService } from './servers.service.js';
import { ServerPreflightIntentService } from './server-intents.service.js';
import { AgentEnrollmentService } from './agent-enrollment.service.js';
import { acceptedIntent } from '../reconcile/accepted-intent.js';

/**
 * Servers: `scope=mine` (default) is the user view of granted servers;
 * `scope=all` and every lifecycle operation need `ManageServers`.
 */
@Controller('servers')
export class ServersController {
  constructor(
    private readonly servers: ServersService,
    private readonly serverPreflight: ServerPreflightIntentService,
    private readonly enrollment: AgentEnrollmentService,
  ) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query('scope') scope?: string) {
    return this.servers.list(actor, zListScope.parse(scope));
  }

  @Post()
  @RequireCaps(Capability.ManageServers)
  create(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.servers.create(actor.userId, zCreateServerRequest.parse(body));
  }

  @Get(':id')
  get(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    return this.servers.get(actor, id, zListScope.parse(scope));
  }

  /** Issue a fresh one-time agent enrollment token (shown once). */
  @Post(':id/agent-enrollment')
  @RequireCaps(Capability.ManageServers)
  rotateEnrollment(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ) {
    const input = zRotateServerEnrollmentRequest.parse(body);
    return this.enrollment.rotate(actor.userId, id, input.expectedRevision);
  }

  @Get(':id/preflight')
  @RequireCaps(Capability.ManageServers)
  preflight(@Param('id') id: string) {
    return this.servers.findDtoById(id).then((server) => ({
      status: server.preflightStatus,
      report: server.preflightReport,
      checkedAt: server.preflightCheckedAt,
    }));
  }

  @Post(':id/preflight')
  @RequireCaps(Capability.ManageServers)
  @HttpCode(HttpStatus.ACCEPTED)
  async preflightRun(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ) {
    const input = zRunPreflightRequest.parse(body);
    const intent = await this.serverPreflight.create(
      id,
      actor.userId,
      input.expectedServerRevision,
      input.poolId,
      input.probeAddress,
    );
    return acceptedIntent(intent);
  }

  @Patch(':id')
  @RequireCaps(Capability.ManageServers)
  update(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ) {
    return this.servers.update(actor.userId, id, zPatchServerRequest.parse(body));
  }

  @Delete(':id')
  @RequireCaps(Capability.ManageServers)
  delete(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
    @Query('expectedRevision') expectedRevision?: string,
  ) {
    if (expectedRevision === undefined) return this.servers.delete(actor.userId, id);
    const revision = Number(expectedRevision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new BadRequestException('expectedRevision must be a positive integer');
    }
    return this.servers.delete(actor.userId, id, revision);
  }
}
