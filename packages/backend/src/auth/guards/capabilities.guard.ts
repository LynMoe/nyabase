import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CAPS_KEY } from '../decorators/require-caps.decorator.js';
import { AccessResolverService } from '../../access/access-resolver.service.js';
import { Capability } from '@nyabase/common';
import { UserEntity } from '../../entities/user.entity.js';

@Injectable()
export class CapabilitiesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private accessResolver: AccessResolverService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredCaps = this.reflector.getAllAndOverride<Capability[]>(CAPS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const user: UserEntity = context.switchToHttp().getRequest().user;
    if (!user) return false;

    if (!requiredCaps?.length) return true;

    const userCaps = await this.accessResolver.userCapabilities(user.id);
    const ok = requiredCaps.every((c) => userCaps.has(c));
    if (!ok) throw new ForbiddenException();
    return true;
  }
}
