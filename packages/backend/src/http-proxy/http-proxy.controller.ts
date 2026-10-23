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
import { Role, zListScope } from '@nyabase/common';
import { CurrentActor, RequireRole } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { HttpProxyGateway } from './http-proxy-gateway.js';
import { HttpDomainPoolsService } from './http-domain-pools.service.js';
import { HttpProxyBindingsService } from './http-proxy-bindings.service.js';
import { requireUserId } from '../iam/actor.js';

/** HTTP proxy bindings: owners manage their own; `scope=all` lists everyone's (operator). */
@Controller('http-proxy/bindings')
export class HttpProxyController {
  constructor(
    private service: HttpProxyBindingsService,
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
  async delete(@CurrentActor() actor: Actor, @Param('id') id: string, @Query('scope') scope?: string) {
    await this.service.deleteBinding(actor, id, zListScope.parse(scope));
    this.gateway.scheduleBroadcast('binding_deleted');
  }
}

/** Domain pools: enabled ones for everyone (`scope=mine`); management is operator-only. */
@Controller('http-proxy/domain-pools')
export class HttpProxyDomainPoolsController {
  constructor(
    private service: HttpDomainPoolsService,
    private gateway: HttpProxyGateway,
  ) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query('scope') scope?: string) {
    return this.service.listPools(actor, zListScope.parse(scope));
  }

  @Post()
  @RequireRole(Role.Operator)
  async create(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const result = await this.service.createDomainPool(requireUserId(actor), body);
    this.gateway.scheduleBroadcast('domain_pool_created');
    return result;
  }

  @Patch(':id')
  @RequireRole(Role.Operator)
  async update(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const result = await this.service.updateDomainPool(requireUserId(actor), id, body);
    this.gateway.scheduleBroadcast('domain_pool_updated');
    return result;
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireRole(Role.Operator)
  async remove(@CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.service.deleteDomainPool(requireUserId(actor), id);
    this.gateway.scheduleBroadcast('domain_pool_deleted');
  }
}

@Controller('http-proxy/status')
export class HttpProxyStatusController {
  constructor(private gateway: HttpProxyGateway) {}

  @Get()
  @RequireRole(Role.Operator)
  status() {
    return this.gateway.getStatus();
  }
}
