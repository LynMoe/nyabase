import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from '../auth.service.js';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private authService: AuthService) {
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
          return true;
        }
        throw new UnauthorizedException();
      }
    }

    // Support ?token= query param for SSE endpoints (EventSource cannot set headers)
    const queryToken: string | undefined = request.query?.token;
    if (queryToken && !authHeader) {
      request.headers['authorization'] = `Bearer ${queryToken}`;
    }

    return super.canActivate(context) as Promise<boolean>;
  }
}
