import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import type { UserRecord } from '../domain/domain-records.js';
import { EffectiveAccessDto } from '@nyabase/common';

@Controller('me')
@UseGuards(JwtAuthGuard)
export class MeAccessController {
  constructor(private accessResolver: AccessResolverService) {}

  @Get('access')
  async getMyAccess(@CurrentUser() user: UserRecord): Promise<EffectiveAccessDto> {
    const servers = await this.accessResolver.getEffectiveAccess(user.id);
    return { servers };
  }
}
