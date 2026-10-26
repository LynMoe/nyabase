import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { roleAtLeast, type Role } from '@nyabase/common';
import type { Actor } from './actor.js';
import type { UserRecord } from './auth-persistence.js';
import { IS_PUBLIC_KEY, ROLE_KEY } from './decorators.js';
import { AuthService } from './auth.service.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])) {
      return true;
    }
    // The only credential is the browser session's short-lived access JWT.
    const request = context.switchToHttp().getRequest();
    const token = bearerToken(request.headers?.authorization);
    if (!token) throw new UnauthorizedException();
    const { user } = await this.authService.validateAccessToken(token);
    request.user = user;
    request.authContext = { authVersion: user.authVersion };
    return true;
  }
}

/** `Authorization: Bearer <token>`; the scheme is case-insensitive (RFC 9110). */
function bearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

export interface RequestAuthContext {
  authVersion: number;
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])) {
      return true;
    }
    const minimum = this.reflector.getAllAndOverride<Role | undefined>(ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest();
    const user: UserRecord = request.user;
    if (!user) return false;

    // Fail-safe: a route under the /admin namespace must say who may call it.
    if (!minimum && isAdminNamespace(request)) {
      throw new ForbiddenException('Admin route is missing a required role');
    }

    // The role is on the user row JwtAuthGuard already loaded, so a role change
    // applies to the next request; services read the actor via @CurrentActor().
    const authContext = request.authContext as RequestAuthContext | undefined;
    const actor: Actor = {
      userId: user.id,
      role: user.role,
      authKind: 'jwt',
      authVersion: authContext?.authVersion ?? user.authVersion,
    };
    request.actor = actor;

    if (minimum && !roleAtLeast(user.role, minimum)) throw new ForbiddenException();
    return true;
  }
}

function isAdminNamespace(request: { originalUrl?: string; url?: string }): boolean {
  // Express routes match case-insensitively, so `/api/Admin/...` reaches the same handlers.
  const path = (request.originalUrl ?? request.url ?? '').split('?')[0].toLowerCase();
  return path === '/admin' || path.startsWith('/admin/')
    || path === '/api/admin' || path.startsWith('/api/admin/');
}
