import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import {
  AuditAction,
  controlPlaneConfigDefinitions,
  getControlPlaneConfigDefinition,
} from '@nyabase/common';
import { AuditService } from '../audit/audit.service.js';
import {
  NyabaseConfigService,
  type AuthoritativeSystemSettingsSnapshot,
} from '../config/nyabase-config.service.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { RedisDisposableAdapter } from '../runtime/redis-disposable.adapter.js';
import { SshProxyGateway } from '../ssh/ssh-proxy-gateway.js';

const POLL_INTERVAL_MS = 2_000;
const MAX_SAFE_REVISION = BigInt(Number.MAX_SAFE_INTEGER);

export class SystemSettingsRevisionConflictError extends Error {
  constructor(
    readonly current: AuthoritativeSystemSettingsSnapshot,
  ) {
    super(`System settings changed; current revision is ${current.revision}`);
    this.name = 'SystemSettingsRevisionConflictError';
  }

  get currentRevision(): number {
    return this.current.revision;
  }

  get currentSnapshotToken(): string {
    return this.current.snapshotToken;
  }
}

@Injectable()
export class SystemSettingsAuthorityService
implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SystemSettingsAuthorityService.name);
  private pollTimer: NodeJS.Timeout | null = null;
  private unsubscribeRedis: (() => Promise<void>) | null = null;
  private refreshTail: Promise<AuthoritativeSystemSettingsSnapshot> | null = null;
  private shuttingDown = false;

  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly config: NyabaseConfigService,
    private readonly audit: AuditService,
    private readonly sshProxyGateway: SshProxyGateway,
    @Optional()
    private readonly redis?: RedisDisposableAdapter,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.initialize();
    if (this.shuttingDown) return;
    if (this.redis) {
      const unsubscribe = await this.redis.subscribe(
        'system-settings',
        async (payload) => {
          if (this.shuttingDown) return;
          const version = parseWakeVersion(payload);
          if (version !== null && version <= this.config.revision()) return;
          await this.refreshFromPostgres('redis-wake').catch((error: unknown) => {
            this.logger.warn(`System settings wake refresh failed: ${message(error)}`);
          });
        },
      );
      if (this.shuttingDown) {
        await unsubscribe();
        return;
      }
      this.unsubscribeRedis = unsubscribe;
    }
    this.pollTimer = setInterval(() => {
      void this.refreshFromPostgres('poll').catch((error: unknown) => {
        this.logger.warn(`System settings polling refresh failed: ${message(error)}`);
      });
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    const unsubscribe = this.unsubscribeRedis;
    this.unsubscribeRedis = null;
    // A PostgreSQL read may already have started from a poll/wake. Drain that
    // exact coalesced tail so no continuation survives Nest shutdown.
    const refresh = this.refreshTail;
    const [unsubscribeResult, refreshResult] = await Promise.allSettled([
      unsubscribe?.(),
      refresh,
    ]);
    if (unsubscribeResult.status === 'rejected') {
      this.logger.warn(
        `System settings shutdown unsubscribe failed: ${message(unsubscribeResult.reason)}`,
      );
    }
    if (refreshResult.status === 'rejected') {
      this.logger.warn(
        `System settings shutdown refresh failed: ${message(refreshResult.reason)}`,
      );
    }
  }

  async initialize(): Promise<AuthoritativeSystemSettingsSnapshot> {
    const bootstrapValues = this.config.bootstrapEditableValues();
    const bootstrap: AuthoritativeSystemSettingsSnapshot = {
      revision: 1,
      snapshotToken: settingsSnapshotToken(1, bootstrapValues),
      values: bootstrapValues,
    };
    await this.database
      .insertInto('system.settings')
      .values({
        singleton: true,
        revision: bootstrap.revision,
        snapshot_token: bootstrap.snapshotToken,
        values: bootstrap.values,
        updated_by: null,
      })
      .onConflict((conflict) => conflict.column('singleton').doNothing())
      .execute();
    await this.backfillMissingEditableDefaults();
    return this.refreshFromPostgres('startup');
  }

  /**
   * Additive config keys (for example incus.imageSourceServer) must not fail
   * closed on an existing snapshot. Fill missing online-editable defaults and
   * persist a new revision so the snapshot token stays canonical.
   */
  private async backfillMissingEditableDefaults(): Promise<void> {
    const row = await this.database
      .selectFrom('system.settings')
      .select(['revision', 'values'])
      .where('singleton', '=', true)
      .executeTakeFirstOrThrow();
    const values = parseValues(row.values);
    const filled = fillMissingOnlineEditableDefaults(values);
    if (filled.length === 0) return;
    const currentRevision = Number(row.revision);
    const revision = currentRevision + 1;
    const snapshotToken = settingsSnapshotToken(revision, values);
    const updated = await this.database
      .updateTable('system.settings')
      .set({
        revision,
        snapshot_token: snapshotToken,
        values,
      })
      .where('singleton', '=', true)
      .where('revision', '=', String(currentRevision))
      .returning('revision')
      .executeTakeFirst();
    if (!updated) {
      throw new Error('Failed to persist system settings default backfill');
    }
    this.logger.log(
      `Backfilled system settings defaults: ${filled.join(', ')} (revision ${revision})`,
    );
  }

  async refreshFromPostgres(
    reason = 'explicit',
  ): Promise<AuthoritativeSystemSettingsSnapshot> {
    if (this.shuttingDown) {
      throw new Error('System settings authority is stopped');
    }
    if (this.refreshTail) return this.refreshTail;
    const refresh = this.load()
      .then(async (snapshot) => {
        if (this.shuttingDown) return snapshot;
        const previous = this.config.revision();
        const applied = this.config.applyAuthoritativeSnapshot(snapshot);
        if (
          !this.shuttingDown
          && applied
          && snapshot.revision > previous
        ) {
          await this.broadcastSshSnapshot(reason);
        }
        return snapshot;
      })
      .finally(() => {
        if (this.refreshTail === refresh) this.refreshTail = null;
      });
    this.refreshTail = refresh;
    return refresh;
  }

  async update(
    transaction: Transaction<NyabaseDatabase>,
    actorId: string,
    values: Record<string, unknown>,
    expectedRevision: number,
    expectedSnapshotToken: string,
  ): Promise<AuthoritativeSystemSettingsSnapshot> {
    if (Object.keys(values).length === 0) {
      throw new BadRequestException('At least one setting is required');
    }
    if (Object.keys(values).length > 64) {
      throw new BadRequestException(
        'At most 64 settings may be updated at once',
      );
    }
    const current = await loadSnapshot(transaction);
    if (
      current.revision !== expectedRevision
      || current.snapshotToken !== expectedSnapshotToken
    ) {
      throw new SystemSettingsRevisionConflictError(current);
    }
    if (BigInt(current.revision) >= MAX_SAFE_REVISION) {
      throw new BadRequestException('System settings revision is exhausted');
    }

    const nextValues = { ...current.values };
    for (const [key, rawValue] of Object.entries(values)) {
      const definition = getControlPlaneConfigDefinition(key);
      if (!definition) {
        throw new BadRequestException(`Unknown config key: ${key}`);
      }
      if (
        !definition.editable
        || definition.secret
        || definition.restartRequired
      ) {
        throw new BadRequestException(`Config key is not editable: ${key}`);
      }
      if (this.config.field(definition.key).envValuePresent) {
        throw new BadRequestException(
          `Config key is overridden by environment: ${key}`,
        );
      }
      const parsed = definition.schema.safeParse(rawValue);
      if (!parsed.success) {
        throw new BadRequestException(
          `Invalid config value for ${key}: ${
            parsed.error.issues.map((issue) => issue.message).join('; ')
          }`,
        );
      }
      nextValues[key] = parsed.data;
    }

    // Defend the complete-snapshot invariant even if a row was externally
    // modified instead of silently falling back to process-local defaults.
    validateCompleteValues(nextValues);
    const nextRevision = current.revision + 1;
    const next: AuthoritativeSystemSettingsSnapshot = {
      revision: nextRevision,
      snapshotToken: settingsSnapshotToken(nextRevision, nextValues),
      values: nextValues,
    };
    const updated = await transaction
      .updateTable('system.settings')
      .set({
        revision: next.revision,
        snapshot_token: next.snapshotToken,
        values: next.values,
        updated_by: actorId,
        updated_at: new Date(),
      })
      .where('singleton', '=', true)
      .where('revision', '=', String(expectedRevision))
      .where('snapshot_token', '=', expectedSnapshotToken)
      .returning('revision')
      .executeTakeFirst();
    if (!updated) {
      throw new SystemSettingsRevisionConflictError(
        await loadSnapshot(transaction),
      );
    }

    await this.audit.append(
      transaction,
      actorId,
      AuditAction.UpdateSystemSettings,
      'control-plane',
      'system_settings',
      {
        keys: Object.keys(values).sort(),
        revision: next.revision,
      },
    );
    return next;
  }

  /**
   * Called only after the caller-owned PostgreSQL transaction commits.
   * PostgreSQL is already durable; Redis and live proxy refresh are disposable
   * observers and can be recovered by absolute-version polling.
   */
  async committed(snapshot: AuthoritativeSystemSettingsSnapshot): Promise<void> {
    if (this.shuttingDown) return;
    const previous = this.config.revision();
    const applied = this.config.applyAuthoritativeSnapshot(snapshot);
    if (applied && snapshot.revision > previous) {
      await this.broadcastSshSnapshot('local-commit');
    }
    if (this.redis) {
      await this.redis.publish(
        'system-settings',
        JSON.stringify({ version: snapshot.revision }),
      );
    }
  }

  acceptConflict(snapshot: AuthoritativeSystemSettingsSnapshot): void {
    this.config.applyAuthoritativeSnapshot(snapshot);
  }

  private async load(): Promise<AuthoritativeSystemSettingsSnapshot> {
    return loadSnapshot(this.database);
  }

  private async broadcastSshSnapshot(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    try {
      await this.sshProxyGateway.broadcastSnapshot();
    } catch (error) {
      this.logger.warn(
        `System settings SSH snapshot refresh failed (${reason}): ${message(error)}`,
      );
    }
  }
}

type SettingsExecutor =
  | Kysely<NyabaseDatabase>
  | Transaction<NyabaseDatabase>;

async function loadSnapshot(
  executor: SettingsExecutor,
): Promise<AuthoritativeSystemSettingsSnapshot> {
  const row = await executor
    .selectFrom('system.settings')
    .select(['revision', 'snapshot_token', 'values'])
    .where('singleton', '=', true)
    .executeTakeFirstOrThrow();
  const revision = Number(row.revision);
  const values = parseValues(row.values);
  validateCompleteValues(values);
  if (
    !Number.isSafeInteger(revision)
    || revision < 1
    || settingsSnapshotToken(revision, values) !== row.snapshot_token.trim()
  ) {
    throw new Error('Invalid PostgreSQL system settings authority row');
  }
  return {
    revision,
    snapshotToken: row.snapshot_token.trim(),
    values,
  };
}

function parseValues(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PostgreSQL system settings values must be an object');
  }
  return parsed as Record<string, unknown>;
}

export function fillMissingOnlineEditableDefaults(
  values: Record<string, unknown>,
): string[] {
  const filled: string[] = [];
  for (const definition of controlPlaneConfigDefinitions) {
    if (
      !definition.editable
      || definition.restartRequired
      || definition.secret
    ) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(values, definition.key)) continue;
    values[definition.key] = definition.defaultValue;
    filled.push(definition.key);
  }
  return filled;
}

function validateCompleteValues(values: Record<string, unknown>): void {
  for (const definition of controlPlaneConfigDefinitions) {
    if (
      !definition.editable
      || definition.restartRequired
      || definition.secret
    ) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(values, definition.key)) {
      throw new Error(
        `PostgreSQL system settings snapshot is missing ${definition.key}`,
      );
    }
    if (!definition.schema.safeParse(values[definition.key]).success) {
      throw new Error(
        `PostgreSQL system settings snapshot has invalid ${definition.key}`,
      );
    }
  }
}

export function settingsSnapshotToken(
  revision: number,
  values: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ revision, values })))
    .digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function parseWakeVersion(payload: string): number | null {
  try {
    const parsed = JSON.parse(payload) as { version?: unknown };
    return Number.isSafeInteger(parsed.version) && Number(parsed.version) >= 1
      ? Number(parsed.version)
      : null;
  } catch {
    return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
