import {
  BadRequestException,
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  type CallHandler,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { ACT_AS_HEADER, Role, roleAtLeast, UserStatus, zResourceIdentity } from '@nyabase/common';
import { runImpersonated, type ImpersonationContext } from '../platform/request-context.js';
import type { Actor } from './actor.js';
import type { UserRecord } from './auth-persistence.js';
import { IS_PUBLIC_KEY, REFUSE_IMPERSONATION_KEY, ROLE_KEY } from './decorators.js';
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
    const { user: caller } = await this.authService.validateAccessToken(token);
    const target = await resolveImpersonation(
      request.headers,
      caller,
      context,
      this.reflector,
      (id) => this.authService.findUserById(id),
    );
    // Acting as someone: the request is theirs, only the audit knows the caller.
    const user = target ?? caller;
    request.user = user;
    request.authContext = {
      authVersion: user.authVersion,
      ...(target ? { impersonatorId: caller.id } : {}),
    };
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
  impersonatorId?: string;
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
      ...(authContext?.impersonatorId ? { impersonatorId: authContext.impersonatorId } : {}),
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

function denied(message: string): ForbiddenException {
  return new ForbiddenException({ code: 'IMPERSONATION_DENIED', message });
}

/**
 * The user `caller` acts as for this request, or null without the header.
 * Only an administrator may act, only as an active plain user, and never on a
 * route marked `@RefuseImpersonation()`.
 */
export async function resolveImpersonation(
  headers: Record<string, unknown> | undefined,
  caller: UserRecord,
  context: ExecutionContext,
  reflector: Reflector,
  findUserById: (id: string) => Promise<UserRecord | null>,
): Promise<UserRecord | null> {
  const header = headers?.[ACT_AS_HEADER];
  if (header === undefined) return null;
  // Node joins a repeated header with ", ", which is not a valid id either.
  const parsed = zResourceIdentity.safeParse(header);
  if (!parsed.success) throw new BadRequestException(`${ACT_AS_HEADER} must be one user id`);
  if (caller.role !== Role.Admin) throw denied('Only administrators can act as another user');
  if (reflector.getAllAndOverride<boolean | undefined>(REFUSE_IMPERSONATION_KEY, [
    context.getHandler(),
    context.getClass(),
  ])) {
    throw denied('This route cannot be called while acting as another user');
  }
  const target = await findUserById(parsed.data);
  if (!target || target.status !== UserStatus.Active || target.role !== Role.User) {
    throw denied('Can only act as an active user with the user role');
  }
  return target;
}

/**
 * Runs an impersonated request's handler inside its `ImpersonationContext`, so
 * the audit writer can attribute rows to the administrator, and ends the
 * context when the request settles.
 */
@Injectable()
export class ImpersonationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const actor = context.switchToHttp().getRequest<{ actor?: Actor }>().actor;
    if (!actor || actor.authKind !== 'jwt' || !actor.impersonatorId) return next.handle();
    const impersonation: ImpersonationContext = {
      userId: actor.userId,
      impersonatorId: actor.impersonatorId,
      active: true,
    };
    return new Observable((subscriber) => {
      // `handle()` binds the handler to the async context it is called in, so
      // it must be called inside `runImpersonated`, not before it.
      const subscription = runImpersonated(impersonation, () => next.handle().subscribe(subscriber));
      return () => {
        impersonation.active = false;
        subscription.unsubscribe();
      };
    });
  }
}
