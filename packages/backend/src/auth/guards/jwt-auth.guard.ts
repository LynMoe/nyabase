import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from '../auth.service.js';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private authService: AuthService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
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
