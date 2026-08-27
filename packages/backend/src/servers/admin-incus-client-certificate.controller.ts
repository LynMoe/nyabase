import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  Capability,
  zRotateIncusClientCertificateRequest,
} from '@nyabase/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireAnyCaps, RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { IncusClientCertificateService } from './incus-client-certificate.service.js';

@Controller('admin/incus-client-certificate')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AdminIncusClientCertificateController {
  constructor(
    private readonly certificates: IncusClientCertificateService,
  ) {}

  @Get()
  @RequireAnyCaps(Capability.ManageCertificates, Capability.ManageServers)
  get() {
    return this.certificates.getActive();
  }

  @Post('rotate')
  @HttpCode(200)
  @RequireCaps(Capability.ManageCertificates)
  async rotate(
    @CurrentUser() actor: UserRecord,
    @Body() body: unknown,
  ) {
    const input = zRotateIncusClientCertificateRequest.parse(body);
    return this.certificates.rotate(actor.id, input.expectedGeneration);
  }

  @Get('rotations/:id')
  @RequireCaps(Capability.ManageCertificates)
  rotation(@Param('id') id: string) {
    return this.certificates.rotation(id);
  }
}
