import { Injectable, CanActivate, ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard, PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import { Capability } from '@nyabase/common';
import type { Actor } from './actor.js';
import { AccessResolverService } from './access-resolver.service.js';
import type { UserRecord } from './auth-persistence.js';
import { ANY_CAPS_KEY, CAPS_KEY, IS_PUBLIC_KEY } from './decorators.js';
import { AuthService, type JwtPayload } from './auth.service.js';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private authService: AuthService,
    private readonly reflector: Reflector,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])) {
      return true;
    }
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers['authorization'];
    // Bearer-token format dispatch:
    //   - API tokens are emitted as 64-char lowercase hex (32 random bytes,
    //     see AuthService.createApiToken). They never contain '.' so they
    //     can never be mistaken for a 3-segment JWT.
    //   - Everything else (including any future token format with non-hex
    //     characters) falls through to passport-jwt below.
    // Anchored regex is intentional: a partial match would let a JWT-shaped
    // token whose body happens to contain hex be misrouted.
    if (authHeader?.startsWith('Bearer ')) {
      const raw = authHeader.slice(7);
      if (/^[0-9a-f]{64}$/.test(raw)) {
        const user = await this.authService.validateApiToken(raw);
        if (user) {
          request.user = user;
          request.authContext = { kind: 'api-token' as const };
          return true;
        }
        throw new UnauthorizedException();
      }
    }

    const allowed = await (super.canActivate(context) as Promise<boolean>);
    if (allowed) {
      request.authContext = {
        kind: 'jwt' as const,
        authVersion: request.user.authVersion,
      };
    }
    return allowed;
  }
}

export type RequestAuthContext =
  | { kind: 'jwt'; authVersion: number }
  | { kind: 'api-token' };

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

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private authService: AuthService,
    config: NyabaseConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('auth.jwtSecret'),
    });
  }

  async validate(payload: JwtPayload) {
    return this.authService.validateJwtPayload(payload);
  }
}
