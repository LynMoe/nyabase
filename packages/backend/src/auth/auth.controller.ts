import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  Get,
  Delete,
  Param,
} from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { UserEntity } from '../entities/user.entity.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { zLoginRequest, zRefreshTokenRequest, zCreateApiTokenRequest, UserDto } from '@nyabase/common';

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private accessResolver: AccessResolverService,
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
  async login(@Body() body: unknown) {
    const dto = zLoginRequest.parse(body);
    const user = await this.authService.validateUser(dto.username, dto.password);
    const tokens = await this.authService.login(user);
    return { ...tokens, user: await this.userToDto(user) };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: unknown) {
    const { refreshToken } = zRefreshTokenRequest.parse(body);
    return this.authService.refreshTokens(refreshToken);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async logout(@Body() body: unknown) {
    const { refreshToken } = zRefreshTokenRequest.parse(body);
    await this.authService.logout(refreshToken);
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
    return {
      token: { id: entity.id, name: entity.name, lastUsedAt: entity.lastUsedAt, createdAt: entity.createdAt },
      secret,
    };
  }

  @Delete('tokens/:id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async deleteToken(@CurrentUser() user: UserEntity, @Param('id') id: string) {
    await this.authService.deleteApiToken(user.id, id);
  }
}
