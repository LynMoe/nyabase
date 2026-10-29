import {
  Controller,
  Post,
  Body,
  HttpCode,
  Get,
  Req,
  Res,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AuthService,
  RefreshSupersededException,
  RefreshThrottledException,
} from './auth.service.js';
import { CurrentUser, Public } from './decorators.js';
import type { UserRecord } from './auth-persistence.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import {
  zLoginRequest,
  zRotateRefreshTokenRequest,
  UserDto,
} from '@nyabase/common';

export const REFRESH_COOKIE_NAME = 'nyabase_refresh';
/**
 * With Secure cookies the name carries the `__Host-` prefix: browsers then
 * refuse it from any response that sets a Domain, so a tenant site under the
 * same registrable domain cannot toss its own refresh cookie at the panel.
 * The prefix requires Path=/; plain-HTTP development keeps the scoped path.
 */
export const SECURE_REFRESH_COOKIE_NAME = `__Host-${REFRESH_COOKIE_NAME}`;
/** Scope the refresh secret to the endpoints that consume it. */
export const REFRESH_COOKIE_PATH = '/api/auth';

export function refreshCookieName(secure: boolean): string {
  return secure ? SECURE_REFRESH_COOKIE_NAME : REFRESH_COOKIE_NAME;
}
/**
 * Browsers cannot attach a custom header to a cross-site request without a
 * CORS preflight, which the Backend denies for foreign origins. Requiring it
 * on every cookie-reading or cookie-setting endpoint (including login, which
 * would otherwise accept a cross-site urlencoded form) closes CSRF without
 * relying on SameSite alone.
 */
export const AUTH_INTENT_HEADER = 'x-nyabase-auth';

export interface CookieRequest {
  headers: Record<string, string | string[] | undefined>;
}

export interface CookieResponse {
  cookie(name: string, value: string, options: Record<string, unknown>): unknown;
  clearCookie(name: string, options: Record<string, unknown>): unknown;
  setHeader(name: string, value: string): unknown;
}

export function requireAuthIntent(request: CookieRequest): void {
  if (request.headers[AUTH_INTENT_HEADER] !== '1') {
    throw new ForbiddenException({
      code: 'AUTH_INTENT_REQUIRED',
      message: `${AUTH_INTENT_HEADER}: 1 header is required`,
    });
  }
}

export function readRefreshCookie(request: CookieRequest, secure: boolean): string | null {
  const header = request.headers.cookie;
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (!raw) return null;
  const name = refreshCookieName(secure);
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    // Issued tokens are URL-safe; anything else was not set by this Backend,
    // so keep looking instead of letting a planted value shadow the real one.
    if (/^[A-Za-z0-9_-]{1,256}$/.test(value)) return value;
  }
  return null;
}

function cookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: secure ? '/' : REFRESH_COOKIE_PATH,
  } as const;
}

export function setRefreshCookie(
  response: CookieResponse,
  token: string,
  options: { secure: boolean; maxAgeMs: number },
): void {
  response.cookie(refreshCookieName(options.secure), token, {
    ...cookieOptions(options.secure),
    maxAge: options.maxAgeMs,
  });
}

export function clearRefreshCookie(response: CookieResponse, secure: boolean): void {
  response.clearCookie(refreshCookieName(secure), cookieOptions(secure));
}

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private config: NyabaseConfigService,
  ) {}

  private cookieSecure(): boolean {
    return this.config.get<boolean>('auth.cookieSecure');
  }

  private async userToDto(
    user: Pick<
      UserRecord,
      'id' | 'username' | 'displayName' | 'status' | 'createdAt' | 'role' | 'mustChangePassword'
    >,
  ): Promise<UserDto> {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: CookieRequest & { ip?: string },
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    requireAuthIntent(request);
    const dto = zLoginRequest.parse(body);
    // Express derives `ip` from the socket peer unless server.trustedProxies
    // names the forwarding proxy, so X-Forwarded-For is never trusted blindly.
    const { user, accessToken, refreshToken } = await this.authService.authenticateAndLogin(
      dto.username,
      dto.password,
      request.ip ?? 'unknown',
    );
    setRefreshCookie(response, refreshToken, {
      secure: this.cookieSecure(),
      maxAgeMs: this.authService.refreshCookieMaxAgeMs(),
    });
    return { accessToken, user: await this.userToDto(user) };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() body: unknown,
    @Req() request: CookieRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    requireAuthIntent(request);
    const { requestId } = zRotateRefreshTokenRequest.parse(body);
    const presented = readRefreshCookie(request, this.cookieSecure());
    if (!presented) throw new UnauthorizedException('Invalid refresh token');
    let rotated: Awaited<ReturnType<AuthService['refreshTokens']>>;
    try {
      rotated = await this.authService.refreshTokens(presented, requestId);
    } catch (error) {
      // Throttled: the session is intact; tell the client when to come back.
      if (error instanceof RefreshThrottledException) {
        response.setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      // A superseded refresh lost a concurrent rotation: the cookie jar may
      // already hold the winner's successor, which a clear would destroy.
      if (
        error instanceof UnauthorizedException
        && !(error instanceof RefreshSupersededException)
      ) clearRefreshCookie(response, this.cookieSecure());
      throw error;
    }
    setRefreshCookie(response, rotated.refreshToken, {
      secure: this.cookieSecure(),
      maxAgeMs: rotated.cookieMaxAgeMs,
    });
    return { accessToken: rotated.accessToken, user: await this.userToDto(rotated.user) };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: CookieRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    requireAuthIntent(request);
    const presented = readRefreshCookie(request, this.cookieSecure());
    clearRefreshCookie(response, this.cookieSecure());
    if (presented) await this.authService.logout(presented);
  }

  @Get('me')
  async me(@CurrentUser() user: UserRecord) {
    return this.userToDto(user);
  }
}
