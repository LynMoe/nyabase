import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  Get,
  Delete,
  Param,
  Req,
} from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import {
  zLoginRequest,
  zRefreshTokenRequest,
  zRotateRefreshTokenRequest,
  zCreateApiTokenRequest,
  UserDto,
} from '@nyabase/common';

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private accessResolver: AccessResolverService,
  ) {}

  private async userToDto(user: UserRecord): Promise<UserDto> {
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

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: { socket: { remoteAddress?: string } },
  ) {
    const dto = zLoginRequest.parse(body);
    // Deliberately use the actual peer address. Forwarded headers are not
    // trusted unless the deployment has an explicit trusted-proxy policy.
    const { user, ...tokens } = await this.authService.authenticateAndLogin(
      dto.username,
      dto.password,
      request.socket.remoteAddress ?? 'unknown',
    );
    return { ...tokens, user: await this.userToDto(user) };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: unknown) {
    const { refreshToken, requestId } = zRotateRefreshTokenRequest.parse(body);
    return this.authService.refreshTokens(refreshToken, requestId);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: unknown) {
    const { refreshToken } = zRefreshTokenRequest.parse(body);
    await this.authService.logout(refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: UserRecord) {
    return this.userToDto(user);
  }

  @Get('tokens')
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
  async createToken(@CurrentUser() user: UserRecord, @Body() body: unknown) {
    const { name } = zCreateApiTokenRequest.parse(body);
    const { entity, secret } = await this.authService.createApiToken(user.id, name);
    return {
      token: { id: entity.id, name: entity.name, lastUsedAt: entity.lastUsedAt, createdAt: entity.createdAt },
      secret,
    };
  }

  @Delete('tokens/:id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async deleteToken(@CurrentUser() user: UserRecord, @Param('id') id: string) {
    await this.authService.deleteApiToken(user.id, id);
  }
}
