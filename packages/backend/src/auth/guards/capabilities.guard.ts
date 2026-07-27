import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ANY_CAPS_KEY, CAPS_KEY } from '../decorators/require-caps.decorator.js';
import { AccessResolverService } from '../../access/access-resolver.service.js';
import { Capability } from '@nyabase/common';
import type { UserRecord } from '../../domain/domain-records.js';

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
    const anyCaps = this.reflector.getAllAndOverride<Capability[]>(ANY_CAPS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest();
    const user: UserRecord = request.user;
    if (!user) return false;

    if (!requiredCaps?.length && !anyCaps?.length) {
      if (this.isAdminRequest(request)) {
        throw new ForbiddenException('Admin route is missing required capabilities');
      }
      return true;
    }

    const userCaps = await this.accessResolver.userCapabilitiesCurrent(user.id);
    const allSatisfied = !requiredCaps?.length || requiredCaps.every((c) => userCaps.has(c));
    const anySatisfied = !anyCaps?.length || anyCaps.some((c) => userCaps.has(c));
    const ok = allSatisfied && anySatisfied;
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
