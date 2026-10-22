import { createParamDecorator, ExecutionContext, SetMetadata, UnauthorizedException } from '@nestjs/common';
import type { Role } from '@nyabase/common';
import type { Actor } from './actor.js';
import type { UserRecord } from './auth-persistence.js';

export const IS_PUBLIC_KEY = 'is_public_route';

/** Opts a route out of the global JWT and role guards. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLE_KEY = 'required_role';
/** Minimum role for a route; a method-level declaration overrides the class-level one. */
export const RequireRole = (minimum: Role) => SetMetadata(ROLE_KEY, minimum);

/** The authenticated caller, as built once per request by `RolesGuard`. */
export const CurrentActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Actor => {
    const actor = ctx.switchToHttp().getRequest<{ actor?: Actor }>().actor;
    if (!actor) throw new UnauthorizedException();
    return actor;
  },
);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): UserRecord => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
