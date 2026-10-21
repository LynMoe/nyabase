import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import { AccessChangeNotifier, AccessResolverService } from './access-resolver.service.js';
import { AuditRepository } from './audit.repository.js';
import { AuditService } from './audit.service.js';
import { AuditSnapshotResolver } from './audit-snapshot.resolver.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { CapabilitiesGuard, JwtAuthGuard, JwtStrategy } from './guards.js';
import { IamAuthRepository } from './iam-auth.repository.js';

/**
 * Authentication, authorization resolution and the audit writer. The two
 * guards are registered globally; routes opt out with `@Public()`.
 */
@Global()
@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [NyabaseConfigService],
      useFactory: (config: NyabaseConfigService) => ({
        secret: config.get<string>('auth.jwtSecret'),
        // The config schema accepts only `<n>s|m|h|d`, a valid `ms` duration.
        signOptions: {
          expiresIn: config.get<string>('auth.jwtExpiresIn') as JwtSignOptions['expiresIn'],
        },
      }),
    }),
  ],
  providers: [
    IamAuthRepository,
    AuthService,
    JwtStrategy,
    AccessChangeNotifier,
    AccessResolverService,
    AuditRepository,
    AuditSnapshotResolver,
    AuditService,
    JwtAuthGuard,
    CapabilitiesGuard,
    // Registration order is execution order: authenticate, then authorize.
    { provide: APP_GUARD, useFactory: (guard: JwtAuthGuard) => guard, inject: [JwtAuthGuard] },
    { provide: APP_GUARD, useFactory: (guard: CapabilitiesGuard) => guard, inject: [CapabilitiesGuard] },
  ],
  controllers: [AuthController],
  exports: [
    AuthService,
    AccessChangeNotifier,
    AccessResolverService,
    AuditRepository,
    AuditService,
  ],
})
export class IamModule {}
