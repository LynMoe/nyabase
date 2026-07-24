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
import { UserEntity } from '../entities/user.entity.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import {
  AuditAction,
  zLoginRequest,
  zRefreshTokenRequest,
  zRotateRefreshTokenRequest,
  zCreateApiTokenRequest,
  UserDto,
} from '@nyabase/common';
import { AuditService } from '../audit/audit.service.js';
import { postCommitBestEffort } from '../common/post-commit.js';

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private accessResolver: AccessResolverService,
    private audit: AuditService,
  ) {}

  private async userToDto(user: UserEntity): Promise<UserDto> {
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
    await postCommitBestEffort(
      'User login audit',
      () => this.audit.log(user.id, AuditAction.UserLogin, user.id, 'user'),
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
    const userId = await this.authService.logout(refreshToken);
    if (userId) {
      await postCommitBestEffort(
        'User logout audit',
        () => this.audit.log(userId, AuditAction.UserLogout, userId, 'user'),
      );
    }
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: UserEntity) {
    return this.userToDto(user);
  }

  @Get('tokens')
  @UseGuards(JwtAuthGuard)
  async listTokens(@CurrentUser() user: UserEntity) {
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
  async createToken(@CurrentUser() user: UserEntity, @Body() body: unknown) {
    const { name } = zCreateApiTokenRequest.parse(body);
    const { entity, secret } = await this.authService.createApiToken(user.id, name);
    await postCommitBestEffort(
      'API token create audit',
      () => this.audit.log(user.id, AuditAction.CreateApiToken, entity.id, 'api_token', {
        name: entity.name,
      }),
    );
    return {
      token: { id: entity.id, name: entity.name, lastUsedAt: entity.lastUsedAt, createdAt: entity.createdAt },
      secret,
    };
  }

  @Delete('tokens/:id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async deleteToken(@CurrentUser() user: UserEntity, @Param('id') id: string) {
    const token = await this.authService.deleteApiToken(user.id, id);
    await postCommitBestEffort(
      'API token delete audit',
      () => this.audit.log(user.id, AuditAction.DeleteApiToken, token.id, 'api_token', {
        name: token.name,
      }),
    );
  }
}
