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

    const request = context.switchToHttp().getRequest();
    const user: UserEntity = request.user;
    if (!user) return false;

    if (!requiredCaps?.length) {
      if (this.isAdminRequest(request)) {
        throw new ForbiddenException('Admin route is missing required capabilities');
      }
      return true;
    }

    const userCaps = await this.accessResolver.userCapabilities(user.id);
    const ok = requiredCaps.every((c) => userCaps.has(c));
    if (!ok) throw new ForbiddenException();
    return true;
  }

  private isAdminRequest(request: { originalUrl?: string; url?: string; path?: string; route?: { path?: string } }): boolean {
    const candidates = [
      request.originalUrl,
      request.url,
      request.path,
      request.route?.path,
    ].filter((value): value is string => typeof value === 'string');
    return candidates.some((value) => {
      const path = value.split('?')[0];
      return path === '/admin' || path.startsWith('/admin/') || path === '/api/admin' || path.startsWith('/api/admin/');
    });
  }
}
