import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuditAction, Capability } from '@nyabase/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserEntity } from '../entities/user.entity.js';
import { AuditService } from '../audit/audit.service.js';
import { postCommitBestEffort } from '../common/post-commit.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { HttpProxyGateway } from './http-proxy-gateway.js';
import { HttpProxyService } from './http-proxy.service.js';

@Controller('admin/http-proxy')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AdminHttpProxyController {
  constructor(
    private service: HttpProxyService,
    private gateway: HttpProxyGateway,
    private audit: AuditService,
  ) {}

  @Get('status')
  @RequireCaps(Capability.ViewMetricsAll)
  status() {
    return this.gateway.getStatus();
  }

  @Get('domain-pools')
  @RequireCaps(Capability.ManageSystemSettings)
  listDomainPools() {
    return this.service.listDomainPools();
  }

  @Post('domain-pools')
  @RequireCaps(Capability.ManageSystemSettings)
  async createDomainPool(@CurrentUser() actor: UserEntity, @Body() body: unknown) {
    const result = await this.service.createDomainPool(actor.id, body);
    this.gateway.scheduleBroadcast('domain_pool_created');
    await postCommitBestEffort(
      'HTTP domain pool create audit',
      () => this.audit.log(actor.id, AuditAction.CreateHttpDomainPool, result.id, 'http_domain_pool', {
        wildcardDomain: result.wildcardDomain,
        enabled: result.enabled,
        httpsEnabled: result.httpsEnabled,
        certificateFingerprint: result.certificateFingerprint,
      }),
    );
    return result;
  }

  @Patch('domain-pools/:id')
  @RequireCaps(Capability.ManageSystemSettings)
  async updateDomainPool(
    @CurrentUser() actor: UserEntity,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const result = await this.service.updateDomainPool(actor.id, id, body);
    this.gateway.scheduleBroadcast('domain_pool_updated');
    await postCommitBestEffort(
      'HTTP domain pool update audit',
      () => this.audit.log(actor.id, AuditAction.UpdateHttpDomainPool, result.id, 'http_domain_pool', {
        wildcardDomain: result.wildcardDomain,
        enabled: result.enabled,
        httpsEnabled: result.httpsEnabled,
        certificateFingerprint: result.certificateFingerprint,
      }),
    );
    return result;
  }

  @Delete('domain-pools/:id')
  @HttpCode(204)
  @RequireCaps(Capability.ManageSystemSettings)
  async deleteDomainPool(@CurrentUser() actor: UserEntity, @Param('id') id: string) {
    await this.service.deleteDomainPool(actor.id, id);
    this.gateway.scheduleBroadcast('domain_pool_deleted');
    await postCommitBestEffort(
      'HTTP domain pool delete audit',
      () => this.audit.log(actor.id, AuditAction.DeleteHttpDomainPool, id, 'http_domain_pool'),
    );
  }
}
