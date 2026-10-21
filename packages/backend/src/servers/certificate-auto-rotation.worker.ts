import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import {
  CertificateState,
  IntentKind,
  IntentStatus,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { SYSTEM_ACTOR_USERNAME } from '../iam/system-actor.js';
import { IncusClientCertificateService } from './incus-client-certificate.service.js';

export const CERTIFICATE_ROTATION_WARNING_MS = 90 * 24 * 60 * 60 * 1000;
const ROTATION_INTERVAL_MS = 60_000;
const ROTATION_INTERVAL_JITTER_MS = 15_000;

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
    private readonly certificates: IncusClientCertificateService,
  ) {}

  onModuleInit(): void {
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
    if (this.stopped) return;
    if (this.processing) return this.processing;
    const processing = this.processPass();
    this.processing = processing;
    try {
      await processing;
    } finally {
      if (this.processing === processing) this.processing = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
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

  private async processPass(): Promise<void> {
    try {
      const active = await this.database
        .selectFrom('system.incus_client_certificates')
        .selectAll()
        .where('state', '=', CertificateState.Active)
        .executeTakeFirst();
      if (!active) return;

      const remainingMs = new Date(active.not_after).getTime() - Date.now();
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
        .where('username', '=', SYSTEM_ACTOR_USERNAME)
        .executeTakeFirst();
      if (!systemActor) {
        this.logger.warn(
          'Automatic certificate rotation skipped: nyabase-system user is absent',
        );
        return;
      }

      await this.certificates.rotateAsSystem(systemActor.id, Number(active.generation));
    } catch (error) {
      this.logger.error(
        `Automatic certificate rotation pass failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
