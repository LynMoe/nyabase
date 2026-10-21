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
import { Capability, zListScope } from '@nyabase/common';
import { CurrentActor } from '../iam/decorators/current-actor.decorator.js';
import { RequireAnyCaps, RequireCaps } from '../iam/decorators/require-caps.decorator.js';
import type { Actor } from '../iam/actor.js';
import { HttpProxyGateway } from './http-proxy-gateway.js';
import { HttpProxyService } from './http-proxy.service.js';

/** HTTP proxy bindings: owners manage their own; `scope=all` lists everyone's (`ManageSystemSettings`). */
@Controller('http-proxy/bindings')
export class HttpProxyController {
  constructor(
    private service: HttpProxyService,
    private gateway: HttpProxyGateway,
  ) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query('scope') scope?: string) {
    return this.service.listBindings(actor, zListScope.parse(scope), this.gateway.isOnline());
  }

  @Post()
  async create(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const result = await this.service.createBinding(actor, body);
    this.gateway.scheduleBroadcast('binding_created');
    return result;
  }

  @Patch(':id')
  async update(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const result = await this.service.updateBinding(actor, id, body);
    this.gateway.scheduleBroadcast('binding_updated');
    return result;
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.service.deleteBinding(actor, id);
    this.gateway.scheduleBroadcast('binding_deleted');
  }
}

/** Domain pools: enabled ones for everyone (`scope=mine`); management is `ManageSystemSettings`. */
@Controller('http-proxy/domain-pools')
export class HttpProxyDomainPoolsController {
  constructor(
    private service: HttpProxyService,
    private gateway: HttpProxyGateway,
  ) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query('scope') scope?: string) {
    return this.service.listPools(actor, zListScope.parse(scope));
  }

  @Post()
  @RequireCaps(Capability.ManageSystemSettings)
  async create(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const result = await this.service.createDomainPool(actor.userId, body);
    this.gateway.scheduleBroadcast('domain_pool_created');
    return result;
  }

  @Patch(':id')
  @RequireCaps(Capability.ManageSystemSettings)
  async update(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const result = await this.service.updateDomainPool(actor.userId, id, body);
    this.gateway.scheduleBroadcast('domain_pool_updated');
    return result;
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireCaps(Capability.ManageSystemSettings)
  async remove(@CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.service.deleteDomainPool(actor.userId, id);
    this.gateway.scheduleBroadcast('domain_pool_deleted');
  }
}

@Controller('http-proxy/status')
export class HttpProxyStatusController {
  constructor(private gateway: HttpProxyGateway) {}

  @Get()
  @RequireAnyCaps(
    Capability.ViewMetricsAll,
    Capability.ViewAudit,
    Capability.ManageSystemSettings,
  )
  status() {
    return this.gateway.getStatus();
  }
}
