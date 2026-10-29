import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule, type JwtModuleOptions, type JwtSignOptions } from '@nestjs/jwt';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import { AccessChangeNotifier, AccessResolverService } from './access-resolver.service.js';
import { AuditRepository } from './audit.repository.js';
import { AuditService } from './audit.service.js';
import { AuditSnapshotResolver } from './audit-snapshot.resolver.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { ImpersonationInterceptor, JwtAuthGuard, RolesGuard } from './guards.js';
import { IamAuthRepository } from './iam-auth.repository.js';
import { SessionRevocationService } from './session-revocation.service.js';

/** Access JWTs are HS256 only; verification refuses every other algorithm. */
export function accessJwtOptions(config: Pick<NyabaseConfigService, 'get'>): JwtModuleOptions {
  return {
    secret: config.get<string>('auth.jwtSecret'),
    // The config schema accepts only `<n>s|m|h|d`, a valid `ms` duration.
    signOptions: {
      algorithm: 'HS256',
      expiresIn: config.get<string>('auth.jwtExpiresIn') as JwtSignOptions['expiresIn'],
    },
    verifyOptions: { algorithms: ['HS256'] },
  };
}

/**
 * Authentication, authorization resolution and the audit writer. The two
 * guards are registered globally; routes opt out with `@Public()`.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [NyabaseConfigService],
      useFactory: accessJwtOptions,
    }),
  ],
  providers: [
    IamAuthRepository,
    AuthService,
    AccessChangeNotifier,
    AccessResolverService,
    AuditRepository,
    AuditSnapshotResolver,
    AuditService,
    SessionRevocationService,
    JwtAuthGuard,
    RolesGuard,
    // Registration order is execution order: authenticate, then authorize.
    { provide: APP_GUARD, useFactory: (guard: JwtAuthGuard) => guard, inject: [JwtAuthGuard] },
    { provide: APP_GUARD, useFactory: (guard: RolesGuard) => guard, inject: [RolesGuard] },
    { provide: APP_INTERCEPTOR, useClass: ImpersonationInterceptor },
  ],
  controllers: [AuthController],
  exports: [
    AuthService,
    AccessChangeNotifier,
    AccessResolverService,
    AuditRepository,
    AuditService,
    SessionRevocationService,
  ],
})
export class IamModule {}
