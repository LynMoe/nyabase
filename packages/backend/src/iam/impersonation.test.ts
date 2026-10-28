import { Controller, Get, Module, Post } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ACT_AS_HEADER, AuditAction, Role, UserStatus } from '@nyabase/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReconcileWakeService } from '../reconcile/reconcile-wake.service.js';
import type { Actor } from './actor.js';
import type { AuthUser } from './auth-persistence.js';
import { AuditRepository } from './audit.repository.js';
import { AuditService } from './audit.service.js';
import { AuditSnapshotResolver } from './audit-snapshot.resolver.js';
import { AuthService } from './auth.service.js';
import { CurrentActor, CurrentUser, RefuseImpersonation, RequireRole } from './decorators.js';
import { ImpersonationInterceptor, JwtAuthGuard, RolesGuard } from './guards.js';
import { IamModule } from './iam.module.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import { MonotonicClock } from '../platform/monotonic-clock.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';

function user(id: string, role: Role, status = UserStatus.Active): AuthUser {
  return {
    id,
    numericId: 1,
    username: id,
    passwordHash: '',
    displayName: id,
    status,
    authVersion: 4,
    role,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const USERS = new Map<string, AuthUser>([
  ['admin', user('admin', Role.Admin)],
  ['alice', user('alice', Role.User)],
  ['bob', user('bob', Role.User)],
  ['carol', user('carol', Role.UserAdmin)],
  ['dave', user('dave', Role.User, UserStatus.Disabled)],
  ['root2', user('root2', Role.Admin)],
]);
/** Each token authenticates as the user of the same name. */
const TOKEN_SUFFIX = '-token-0123456789abcdef';

const fakeAuth = {
  async validateAccessToken(token: string) {
    const found = USERS.get(token.replace(TOKEN_SUFFIX, ''));
    if (!found) throw new Error('unknown token');
    return { user: found, sessionId: 'session', expiresAt: new Date(Date.now() + 60_000) };
  },
  async findUserById(id: string) {
    return USERS.get(id) ?? null;
  },
};

const appended: Array<{ actorId: string | null; impersonatorId: string | null; action: string }> = [];
const fakeAuditRepository = {
  async append(_executor: unknown, event: { actorId: string | null; impersonatorId: string | null; action: string }) {
    appended.push({ actorId: event.actorId, impersonatorId: event.impersonatorId, action: event.action });
  },
  async enforceRetention() {
    return 0;
  },
};
const delayed: Array<Promise<void>> = [];
const json = async (response: Response) => await response.json() as Record<string, unknown>;
const later = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

@Controller('probe')
class ProbeController {
  constructor(
    private readonly audit: AuditService,
    private readonly wake: ReconcileWakeService,
  ) {}

  @Get('actor')
  async actor(@CurrentActor() actor: Actor, @CurrentUser() current: AuthUser) {
    await later(1);
    // The same request writes rows for its actor, the system and someone else.
    await this.audit.log(actor.userId, AuditAction.CreateContainer, null, null);
    await this.audit.log(null, AuditAction.DeleteContainer, null, null);
    await this.audit.log('bob', AuditAction.RestartContainer, null, null);
    // Work the request leaves running must not be attributed once it ended.
    delayed.push(later(30).then(() => this.audit.log(actor.userId, AuditAction.StartContainer, null, null)));
    return { actor, userId: current.id };
  }

  @Post('wake')
  wakeWorker(@CurrentActor() actor: Actor) {
    // A worker woken here keeps running other people's work afterwards.
    const userId = actor.userId!;
    const stop = this.wake.onWake(() => {
      stop();
      delayed.push(this.audit.log(userId, AuditAction.StopContainer, null, null));
    });
    this.wake.wake({ reason: 'intent' });
    return { ok: true };
  }

  @Post('fails')
  async fails(@CurrentActor() actor: Actor) {
    delayed.push(later(30).then(() => this.audit.log(actor.userId, AuditAction.StartContainer, null, null)));
    await later(1);
    throw new Error('handler failed');
  }

  @Post('refused')
  @RefuseImpersonation()
  refused() {
    return { ok: true };
  }

  @Get('staff')
  @RequireRole(Role.UserAdmin)
  staff() {
    return { ok: true };
  }
}

@Module({
  controllers: [ProbeController],
  providers: [
    ReconcileWakeService,
    { provide: AuthService, useValue: fakeAuth },
    { provide: AuditRepository, useValue: fakeAuditRepository },
    { provide: PgTransactionManager, useValue: { run: (work: (tx: object) => unknown) => work({}) } },
    { provide: NyabaseConfigService, useValue: { get: () => 0 } },
    { provide: AuditSnapshotResolver, useValue: { resolve: async () => null } },
    { provide: MonotonicClock, useValue: { now: () => 0 } },
    AuditService,
    JwtAuthGuard,
    RolesGuard,
    { provide: APP_GUARD, useFactory: (guard: JwtAuthGuard) => guard, inject: [JwtAuthGuard] },
    { provide: APP_GUARD, useFactory: (guard: RolesGuard) => guard, inject: [RolesGuard] },
    { provide: APP_INTERCEPTOR, useClass: ImpersonationInterceptor },
  ],
})
class ProbeModule {}

describe('acting as another user (X-Nyabase-Act-As)', () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(ProbeModule, { logger: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await Promise.all(delayed);
    appended.length = 0;
    delayed.length = 0;
  });

  function call(method: string, path: string, caller: string, actAs?: string) {
    return fetch(`${baseUrl}/api/probe/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${caller}${TOKEN_SUFFIX}`,
        ...(actAs === undefined ? {} : { [ACT_AS_HEADER]: actAs }),
      },
    });
  }

  it('runs an administrator request as the plain user it names', async () => {
    const response = await call('GET', 'actor', 'admin', 'alice');
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      actor: { userId: 'alice', role: Role.User, authKind: 'jwt', authVersion: 4, impersonatorId: 'admin' },
      userId: 'alice',
    });
  });

  it('attributes only the impersonated user\'s rows to the administrator, and only during the request', async () => {
    await call('GET', 'actor', 'admin', 'alice');
    await Promise.all(delayed);

    expect(appended).toEqual([
      { actorId: 'alice', impersonatorId: 'admin', action: AuditAction.CreateContainer },
      { actorId: null, impersonatorId: null, action: AuditAction.DeleteContainer },
      { actorId: 'bob', impersonatorId: null, action: AuditAction.RestartContainer },
      { actorId: 'alice', impersonatorId: null, action: AuditAction.StartContainer },
    ]);
  });

  it('ends the impersonation when the handler fails, too', async () => {
    expect((await call('POST', 'fails', 'admin', 'alice')).status).toBe(500);
    await Promise.all(delayed);

    expect(appended).toEqual([{ actorId: 'alice', impersonatorId: null, action: AuditAction.StartContainer }]);
  });

  it('is wired into the IAM module that the application imports', () => {
    const providers = Reflect.getMetadata('providers', IamModule) as unknown[];
    expect(providers).toContainEqual({ provide: APP_INTERCEPTOR, useClass: ImpersonationInterceptor });
  });

  it('does not let a worker woken by the request inherit the impersonation', async () => {
    expect((await call('POST', 'wake', 'admin', 'alice')).status).toBe(201);
    await Promise.all(delayed);

    expect(appended).toEqual([{ actorId: 'alice', impersonatorId: null, action: AuditAction.StopContainer }]);
  });

  it('leaves ordinary requests unattributed', async () => {
    const response = await call('GET', 'actor', 'alice');
    expect((await json(response)).actor).toEqual({ userId: 'alice', role: Role.User, authKind: 'jwt', authVersion: 4 });
    await Promise.all(delayed);
    expect(appended.every((row) => row.impersonatorId === null)).toBe(true);
  });

  it('gives the impersonated request the target\'s role, not the administrator\'s', async () => {
    expect((await call('GET', 'staff', 'admin')).status).toBe(200);
    expect((await call('GET', 'staff', 'admin', 'alice')).status).toBe(403);
  });

  it('lets only administrators act, and only as active plain users', async () => {
    const denied = async (caller: string, target: string) => {
      const response = await call('GET', 'actor', caller, target);
      expect(response.status, `${caller} as ${target}`).toBe(403);
      expect((await json(response)).code, `${caller} as ${target}`).toBe('IMPERSONATION_DENIED');
    };
    await denied('carol', 'alice');
    await denied('alice', 'bob');
    await denied('admin', 'carol');
    await denied('admin', 'root2');
    await denied('admin', 'admin');
    await denied('admin', 'dave');
    await denied('admin', 'nobody');
    expect(appended).toEqual([]);
  });

  it('refuses routes marked @RefuseImpersonation() only when impersonating', async () => {
    const response = await call('POST', 'refused', 'admin', 'alice');
    expect(response.status).toBe(403);
    expect((await json(response)).code).toBe('IMPERSONATION_DENIED');
    expect((await call('POST', 'refused', 'alice')).status).toBe(201);
  });

  it('rejects a malformed or repeated header', async () => {
    expect((await call('GET', 'actor', 'admin', '')).status).toBe(400);
    expect((await call('GET', 'actor', 'admin', 'alice, bob')).status).toBe(400);
  });
});
