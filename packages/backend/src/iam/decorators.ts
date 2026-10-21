import { createParamDecorator, ExecutionContext, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import type { Actor } from './actor.js';
import type { UserRecord } from './auth-persistence.js';

export const IS_PUBLIC_KEY = 'is_public_route';

/** Opts a route out of the global JWT and capability guards. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const CAPS_KEY = 'required_capabilities';
export const ANY_CAPS_KEY = 'required_any_capability';
export const RequireCaps = (...caps: Capability[]) => SetMetadata(CAPS_KEY, caps);
export const RequireAnyCaps = (...caps: Capability[]) => SetMetadata(ANY_CAPS_KEY, caps);

/** The authenticated caller, as resolved once per request by `CapabilitiesGuard`. */
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
