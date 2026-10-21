import {
  Controller,
  Post,
  Body,
  HttpCode,
  Get,
  Delete,
  Param,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { Public } from './decorators/public.decorator.js';
import type { UserRecord } from './user-record.js';
import { AccessResolverService } from './access-resolver.service.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import {
  clearRefreshCookie,
  readRefreshCookie,
  requireAuthIntent,
  setRefreshCookie,
  type CookieRequest,
  type CookieResponse,
} from './refresh-cookie.js';
import {
  zLoginRequest,
  zRotateRefreshTokenRequest,
  zCreateApiTokenRequest,
  UserDto,
} from '@nyabase/common';

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private accessResolver: AccessResolverService,
    private config: NyabaseConfigService,
  ) {}

  private cookieSecure(): boolean {
    return this.config.get<boolean>('auth.cookieSecure');
  }

  private async userToDto(
    user: Pick<UserRecord, 'id' | 'username' | 'displayName' | 'status' | 'createdAt'>,
  ): Promise<UserDto> {
    const [capabilities, groups] = await Promise.all([
      this.accessResolver.userCapabilities(user.id),
      this.accessResolver.getUserGroupSummaries(user.id),
    ]);
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
      capabilities: Array.from(capabilities),
      groups,
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
    const presented = readRefreshCookie(request);
    if (!presented) throw new UnauthorizedException('Invalid refresh token');
    let rotated: Awaited<ReturnType<AuthService['refreshTokens']>>;
    try {
      rotated = await this.authService.refreshTokens(presented, requestId);
    } catch (error) {
      if (error instanceof UnauthorizedException) clearRefreshCookie(response, this.cookieSecure());
      throw error;
    }
    setRefreshCookie(response, rotated.refreshToken, {
      secure: this.cookieSecure(),
      maxAgeMs: this.authService.refreshCookieMaxAgeMs(),
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
    const presented = readRefreshCookie(request);
    clearRefreshCookie(response, this.cookieSecure());
    if (presented) await this.authService.logout(presented);
  }

  @Get('me')
  async me(@CurrentUser() user: UserRecord) {
    return this.userToDto(user);
  }

  @Get('tokens')
  async listTokens(@CurrentUser() user: UserRecord) {
    const tokens = await this.authService.listApiTokens(user.id);
    return tokens.map((t) => ({
      id: t.id,
      name: t.name,
      lastUsedAt: t.lastUsedAt,
      createdAt: t.createdAt,
    }));
  }

  @Post('tokens')
  async createToken(@CurrentUser() user: UserRecord, @Body() body: unknown) {
    const { name } = zCreateApiTokenRequest.parse(body);
    const { entity, secret } = await this.authService.createApiToken(user.id, name);
    return {
      token: { id: entity.id, name: entity.name, lastUsedAt: entity.lastUsedAt, createdAt: entity.createdAt },
      secret,
    };
  }

  @Delete('tokens/:id')
  @HttpCode(204)
  async deleteToken(@CurrentUser() user: UserRecord, @Param('id') id: string) {
    await this.authService.deleteApiToken(user.id, id);
  }
}
