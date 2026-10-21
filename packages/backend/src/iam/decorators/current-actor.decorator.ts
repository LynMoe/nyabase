import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Actor } from '../actor.js';

/** The authenticated caller, as resolved once per request by `CapabilitiesGuard`. */
export const CurrentActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Actor => {
    const actor = ctx.switchToHttp().getRequest<{ actor?: Actor }>().actor;
    if (!actor) throw new UnauthorizedException();
    return actor;
  },
);
