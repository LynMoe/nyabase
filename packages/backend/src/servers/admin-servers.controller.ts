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
  UseGuards,
} from '@nestjs/common';
import {
  Capability,
  zConnectServerRequest,
  zCreateServerRequest,
  zPatchServerRequest,
  zRunPreflightRequest,
} from '@nyabase/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireAnyCaps, RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { ServersService } from './servers.service.js';
import { StoragePoolsService } from '../storage-pools/storage-pools.service.js';
import { VolumesService } from '../volumes/volumes.service.js';
import { ServerConnectIntentService } from '../runtime/server-connect-intent.service.js';
import { ServerPreflightIntentService } from '../runtime/server-preflight-intent.service.js';
import { acceptedIntent } from '../domain/domain-utils.js';

@Controller('admin/servers')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageServers)
export class AdminServersController {
  constructor(
    private readonly servers: ServersService,
    private readonly storagePools: StoragePoolsService,
    private readonly volumes: VolumesService,
    private readonly serverConnect: ServerConnectIntentService,
    private readonly serverPreflight: ServerPreflightIntentService,
  ) {}

  @Get()
  @RequireCaps()
  @RequireAnyCaps(Capability.ManageServers, Capability.ManageGrants)
  list() {
    return this.servers.findAllDtos();
  }

  @Post()
  create(@CurrentUser() actor: UserRecord, @Body() body: unknown) {
    return this.servers.create(actor.id, zCreateServerRequest.parse(body));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.servers.findDtoById(id);
  }

  @Post(':id/connect')
  @HttpCode(HttpStatus.ACCEPTED)
  async connect(
    @Param('id') id: string,
    @CurrentUser() actor: UserRecord,
    @Body() body: unknown,
  ) {
    const input = zConnectServerRequest.parse(body);
    const targetGeneration = await this.servers.prepareConnection(
      id,
      input.expectedServerCertFingerprint,
    );
    const intent = await this.serverConnect.create({
      serverId: id,
      trustToken: input.trustToken,
      expectedServerCertFingerprint: input.expectedServerCertFingerprint,
      targetGeneration,
      requestedBy: actor.id,
    });
    return acceptedIntent(intent);
  }

  @Get(':id/preflight')
  preflight(@Param('id') id: string) {
    return this.servers.findDtoById(id).then((server) => ({
      status: server.preflightStatus,
      report: server.preflightReport,
      checkedAt: server.preflightCheckedAt,
    }));
  }

  @Post(':id/preflight')
  @HttpCode(HttpStatus.ACCEPTED)
  async preflightRun(
    @Param('id') id: string,
    @CurrentUser() actor: UserRecord,
    @Body() body: unknown,
  ) {
    const input = zRunPreflightRequest.parse(body);
    const intent = await this.serverPreflight.create(
      id,
      actor.id,
      input.expectedServerRevision,
      input.poolId,
      input.probeAddress,
    );
    return acceptedIntent(intent);
  }

  @Get(':id/storage-pools')
  @RequireCaps()
  @RequireAnyCaps(Capability.ManageServers, Capability.ManageGrants)
  storagePoolsList(@Param('id') id: string) {
    return this.storagePools.list(id, true);
  }

  @Post(':id/storage-pools/discover')
  discoverStoragePools(@Param('id') id: string) {
    return this.storagePools.discover(id);
  }

  @Get(':id/storage-capacity')
  storageCapacity(@Param('id') id: string) {
    return this.volumes.capacityForAdmin(id);
  }

  @Get(':id/gpus')
  async gpus(@Param('id') id: string) {
    return { items: await this.servers.listGpus(id) };
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentUser() actor: UserRecord,
    @Body() body: unknown,
  ) {
    return this.servers.update(actor.id, id, zPatchServerRequest.parse(body));
  }

  @Delete(':id')
  delete(
    @Param('id') id: string,
    @CurrentUser() actor: UserRecord,
    @Query('expectedRevision') expectedRevision?: string,
  ) {
    if (expectedRevision === undefined) return this.servers.delete(actor.id, id);
    const revision = Number(expectedRevision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new BadRequestException('expectedRevision must be a positive integer');
    }
    return this.servers.delete(actor.id, id, revision);
  }
}
