import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { ANY_CAPS_KEY, CAPS_KEY } from '../decorators/require-caps.decorator.js';
import { AccessResolverService } from '../access-resolver.service.js';
import { Capability } from '@nyabase/common';
import type { UserRecord } from '../user-record.js';
import type { Actor } from '../actor.js';
import type { RequestAuthContext } from './jwt-auth.guard.js';

@Injectable()
export class CapabilitiesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private accessResolver: AccessResolverService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])) {
      return true;
    }
    // Method-level @RequireCaps() (including an empty list) overrides class CAPS_KEY
    // so allSatisfied is true and method-level @RequireAnyCaps can authorize catalog GETs.
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

    // Fail-safe: a route under the /admin namespace must say who may call it.
    if (!requiredCaps?.length && !anyCaps?.length && isAdminNamespace(request)) {
      throw new ForbiddenException('Admin route is missing required capabilities');
    }

    // Resolved once per request; services read it back through @CurrentActor().
    const capabilities = await this.accessResolver.userCapabilities(user.id);
    const authContext = request.authContext as RequestAuthContext | undefined;
    const actor: Actor = {
      userId: user.id,
      capabilities,
      authKind: authContext?.kind === 'api-token' ? 'api-token' : 'jwt',
      authVersion: authContext?.kind === 'jwt' ? authContext.authVersion : user.authVersion,
    };
    request.actor = actor;

    const allSatisfied = !requiredCaps?.length || requiredCaps.every((c) => capabilities.has(c));
    const anySatisfied = !anyCaps?.length || anyCaps.some((c) => capabilities.has(c));
    if (!(allSatisfied && anySatisfied)) throw new ForbiddenException();
    return true;
  }
}

function isAdminNamespace(request: { originalUrl?: string; url?: string }): boolean {
  const path = (request.originalUrl ?? request.url ?? '').split('?')[0];
  return path === '/admin' || path.startsWith('/admin/')
    || path === '/api/admin' || path.startsWith('/api/admin/');
}
