import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Kysely } from 'kysely';
import {
  CertificateState,
  IntentKind,
  IntentStatus,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { RuntimeRoleService } from './runtime-role.service.js';
import { IncusClientCertificateService } from '../servers/incus-client-certificate.service.js';

export const CERTIFICATE_AUTO_ROTATION_CLOCK = Symbol('CERTIFICATE_AUTO_ROTATION_CLOCK');
export const NYABASE_SYSTEM_USERNAME = 'nyabase-system';
export const CERTIFICATE_ROTATION_WARNING_MS = 90 * 24 * 60 * 60 * 1000;
const ROTATION_INTERVAL_MS = 60_000;
const ROTATION_INTERVAL_JITTER_MS = 15_000;

export interface CertificateAutoRotationClock {
  now(): Date;
}

/**
 * Periodically enqueues Incus client-certificate rotation when the active
 * certificate's remaining lifetime is 90 days or less. Manual rotate remains
 * the operator API; this worker uses the durable nyabase-system actor and
 * skips capability checks.
 */
@Injectable()
export class CertificateAutoRotationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CertificateAutoRotationWorker.name);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private processing: Promise<void> | null = null;
  private stopped = false;

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly runtimeRole: RuntimeRoleService,
    private readonly moduleRef: ModuleRef,
    @Optional()
    @Inject(CERTIFICATE_AUTO_ROTATION_CLOCK)
    private readonly clock?: CertificateAutoRotationClock,
    @Optional()
    private readonly certificateService?: IncusClientCertificateService,
  ) {}

  onModuleInit(): void {
    if (!this.runtimeRole.runsWorker()) return;
    this.stopped = false;
    this.scheduleNext();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.processing;
  }

  async tick(): Promise<void> {
    if (this.stopped || !this.runtimeRole.runsWorker()) return;
    if (this.processing) return this.processing;
    const processing = this.processPass();
    this.processing = processing;
    try {
      await processing;
    } finally {
      if (this.processing === processing) this.processing = null;
    }
  }

  private now(): Date {
    return this.clock?.now() ?? new Date();
  }

  private scheduleNext(): void {
    if (this.stopped || !this.runtimeRole.runsWorker()) return;
    if (this.timer) clearTimeout(this.timer);
    const jitter = Math.floor((Math.random() * 2 - 1) * ROTATION_INTERVAL_JITTER_MS);
    const delay = Math.max(5_000, ROTATION_INTERVAL_MS + jitter);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
      this.scheduleNext();
    }, delay);
    this.timer.unref?.();
  }

  private resolveCertificates(): IncusClientCertificateService | null {
    if (this.certificateService) return this.certificateService;
    try {
      return this.moduleRef.get(IncusClientCertificateService, { strict: false });
    } catch (error) {
      this.logger.warn(
        `Automatic certificate rotation skipped: certificate service unavailable (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      return null;
    }
  }

  private async processPass(): Promise<void> {
    try {
      const certificates = this.resolveCertificates();
      if (!certificates) return;

      const active = await this.database
        .selectFrom('system.incus_client_certificates')
        .selectAll()
        .where('state', '=', CertificateState.Active)
        .executeTakeFirst();
      if (!active) return;

      const remainingMs = new Date(active.not_after).getTime() - this.now().getTime();
      if (remainingMs > CERTIFICATE_ROTATION_WARNING_MS) return;

      const staged = await this.database
        .selectFrom('system.incus_client_certificates')
        .select('id')
        .where('state', '=', CertificateState.Staged)
        .executeTakeFirst();
      if (staged) return;

      const pending = await this.database
        .selectFrom('control.intents')
        .select('id')
        .where('kind', '=', IntentKind.CertificateRotate)
        .where('status', '=', IntentStatus.Pending)
        .executeTakeFirst();
      if (pending) return;

      const systemActor = await this.database
        .selectFrom('iam.users')
        .select('id')
        .where('username', '=', NYABASE_SYSTEM_USERNAME)
        .executeTakeFirst();
      if (!systemActor) {
        this.logger.warn(
          'Automatic certificate rotation skipped: nyabase-system user is absent',
        );
        return;
      }

      await certificates.rotateAsSystem(systemActor.id, Number(active.generation));
    } catch (error) {
      this.logger.error(
        `Automatic certificate rotation pass failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
