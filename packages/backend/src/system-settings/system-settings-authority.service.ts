import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import {
  AuditAction,
  controlPlaneConfigDefinitions,
  getControlPlaneConfigDefinition,
} from '@nyabase/common';
import { AuditService } from '../iam/audit.service.js';
import {
  NyabaseConfigService,
  type AuthoritativeSystemSettingsSnapshot,
} from '../platform/config/nyabase-config.service.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { ContainerSshConvergenceService } from '../containers/container-ssh.js';
import { SshProxyGateway } from '../ssh/ssh-proxy-gateway.js';

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
}

/**
 * PostgreSQL holds the durable settings row; this single process applies it to
 * the in-memory config at startup and after each committed update. Concurrent
 * edits are resolved only by the revision CAS in update().
 */
@Injectable()
export class SystemSettingsAuthorityService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SystemSettingsAuthorityService.name);

  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly config: NyabaseConfigService,
    private readonly audit: AuditService,
    private readonly sshProxyGateway: SshProxyGateway,
    private readonly containerSsh: ContainerSshConvergenceService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.initialize();
  }

  async initialize(): Promise<AuthoritativeSystemSettingsSnapshot> {
    const bootstrapValues = this.config.bootstrapEditableValues();
    const bootstrap: AuthoritativeSystemSettingsSnapshot = {
      revision: 1,
      values: bootstrapValues,
    };
    await this.database
      .insertInto('system.settings')
      .values({
        singleton: true,
        revision: bootstrap.revision,
        values: bootstrap.values,
        updated_by: null,
      })
      .onConflict((conflict) => conflict.column('singleton').doNothing())
      .execute();
    await this.backfillMissingEditableDefaults();
    return this.refreshFromPostgres();
  }

  /**
   * Additive config keys (for example incus.imageSourceServer) must not fail
   * closed on an existing snapshot. Fill missing online-editable defaults and
   * persist a new revision.
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
    const updated = await this.database
      .updateTable('system.settings')
      .set({
        revision,
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

  async refreshFromPostgres(): Promise<AuthoritativeSystemSettingsSnapshot> {
    const snapshot = await loadSnapshot(this.database);
    const previous = this.config.revision();
    const applied = this.config.applyAuthoritativeSnapshot(snapshot);
    if (applied && snapshot.revision > previous) {
      await this.broadcastSshSnapshot('refresh');
    }
    return snapshot;
  }

  async update(
    transaction: Transaction<NyabaseDatabase>,
    actorId: string,
    values: Record<string, unknown>,
    expectedRevision: number,
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
    if (current.revision !== expectedRevision) {
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
      values: nextValues,
    };
    const updated = await transaction
      .updateTable('system.settings')
      .set({
        revision: next.revision,
        values: next.values,
        updated_by: actorId,
        updated_at: new Date(),
      })
      .where('singleton', '=', true)
      .where('revision', '=', String(expectedRevision))
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
   * PostgreSQL is already durable; applying it to memory and notifying the SSH
   * proxy is a best-effort follow-up.
   */
  async committed(snapshot: AuthoritativeSystemSettingsSnapshot): Promise<void> {
    const previous = this.config.revision();
    const previousSuffix = this.config.get<string>('ssh.proxyHostSuffix');
    const applied = this.config.applyAuthoritativeSnapshot(snapshot);
    if (applied && snapshot.revision > previous) {
      await this.broadcastSshSnapshot('local-commit');
      if (this.config.get<string>('ssh.proxyHostSuffix') !== previousSuffix) {
        // Host certificates name `<container>.<suffix>`: re-sign them all, in the background.
        this.containerSsh.startReconcileAllHostCertificates();
      }
    }
  }

  /** Adopt the value a CAS conflict reported so the 409 body is the stored one. */
  acceptConflict(snapshot: AuthoritativeSystemSettingsSnapshot): void {
    this.config.applyAuthoritativeSnapshot(snapshot);
  }

  private async broadcastSshSnapshot(reason: string): Promise<void> {
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
    .select(['revision', 'values'])
    .where('singleton', '=', true)
    .executeTakeFirstOrThrow();
  const revision = Number(row.revision);
  const values = parseValues(row.values);
  validateCompleteValues(values);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('Invalid PostgreSQL system settings authority row');
  }
  return {
    revision,
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
