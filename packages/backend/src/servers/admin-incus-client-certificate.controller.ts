import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import {
  Capability,
  zRotateIncusClientCertificateRequest,
} from '@nyabase/common';
import { RequireAnyCaps, RequireCaps } from '../iam/decorators/require-caps.decorator.js';
import { CurrentUser } from '../iam/decorators/current-user.decorator.js';
import type { UserRecord } from '../iam/user-record.js';
import { IncusClientCertificateService } from './incus-client-certificate.service.js';

@Controller('admin/incus-client-certificate')
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
