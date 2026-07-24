import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { JwtStrategy } from './jwt.strategy.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from './guards/capabilities.guard.js';
import { UserEntity } from '../entities/user.entity.js';
import { RefreshTokenEntity } from '../entities/refresh-token.entity.js';
import { ApiTokenEntity } from '../entities/api-token.entity.js';
import { AccessModule } from '../access/access.module.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { AuditModule } from '../audit/audit.module.js';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [NyabaseConfigService],
      useFactory: (config: NyabaseConfigService) => ({
        secret: config.get<string>('auth.jwtSecret'),
        signOptions: { expiresIn: config.get<string>('auth.jwtExpiresIn') },
      }),
    }),
    TypeOrmModule.forFeature([UserEntity, RefreshTokenEntity, ApiTokenEntity]),
    AccessModule,
    forwardRef(() => AuditModule),
  ],
  providers: [AuthService, JwtStrategy, JwtAuthGuard, CapabilitiesGuard],
  controllers: [AuthController],
  exports: [AuthService, JwtAuthGuard, CapabilitiesGuard],
})
export class AuthModule {}
