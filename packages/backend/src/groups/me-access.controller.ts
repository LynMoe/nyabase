import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../iam/decorators/current-user.decorator.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import type { UserRecord } from '../iam/user-record.js';
import { EffectiveAccessDto } from '@nyabase/common';

@Controller('me')
export class MeAccessController {
  constructor(private accessResolver: AccessResolverService) {}

  @Get('access')
  async getMyAccess(@CurrentUser() user: UserRecord): Promise<EffectiveAccessDto> {
    return {
      servers: await this.accessResolver.getEffectiveAccess(user.id),
      sharedBackends: await this.accessResolver.getEffectiveSharedAccess(user.id),
    };
  }
}
