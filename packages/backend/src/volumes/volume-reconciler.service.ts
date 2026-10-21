import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { AuditService } from '../iam/audit.service.js';
import { IncusError, type IncusClientPort } from '../incus/index.js';
import { IntentRepository, type IntentFailure, type IntentRecord } from '../reconcile/intent.repository.js';
import type {
  ManagedReconciler,
  ReconcileOutcome,
  ReconcileRunContext,
  ResourceAuthority,
} from '../reconcile/managed-reconciler.js';
import { ReconcilerRegistry } from '../reconcile/reconciler-registry.service.js';
import { INCUS_CLIENT_FACTORY, type IncusClientFactory } from '../incus/incus-client.factory.js';
import { reconcileDestroy } from './volume-destroy.js';
import { adoptOrCreate, alignSizeAndShifted } from './volume-ensure.js';
import type { VolumeReconcileDeps } from './volume-reconcile-deps.js';
import { VolumeReconcileStore } from './volume-reconcile.store.js';
import {
  VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS,
  destroyRetry,
  isNotFound,
  volumeFailure,
  type StorageVolume,
} from './volume-reconcile-support.js';
import { scanServerVolumes } from './volume-scan.js';

/**
 * Drives volume intents against Incus: ensure/resize converge the custom volume
 * on one server, destroy removes it from every catalog. The Incus-facing steps
 * live in volume-ensure / volume-destroy / volume-scan; all SQL is in the store.
 */
@Injectable()
export class VolumeReconciler implements ManagedReconciler, OnModuleInit {
  readonly resourceType = 'volume' as const;
  private readonly logger = new Logger(VolumeReconciler.name);
  private readonly store: VolumeReconcileStore;
  private readonly deps: VolumeReconcileDeps;

  constructor(
    @Inject(PG_DATABASE) database: Kysely<NyabaseDatabase>,
    intents: IntentRepository,
    audit: AuditService,
    @Inject(INCUS_CLIENT_FACTORY) clients: IncusClientFactory,
    private readonly registry: ReconcilerRegistry,
  ) {
    this.store = new VolumeReconcileStore(database, intents, this.logger);
    this.deps = { store: this.store, audit, clients, logger: this.logger };
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  supports(intent: IntentRecord): boolean {
    return intent.resourceType === this.resourceType;
  }

  needsAttention(volumeId: string): Promise<boolean> {
    return this.store.needsAttention(volumeId);
  }

  markSucceeded(volumeId: string, revision: number): Promise<void> {
    return this.store.markSucceeded(volumeId, revision);
  }

  markFailure(volumeId: string, failure: IntentFailure, attention: boolean): Promise<void> {
    return this.store.markFailure(volumeId, failure, attention);
  }

  resourceAuthorities(volumeIds: readonly string[]): Promise<Map<string, ResourceAuthority>> {
    return this.store.resourceAuthorities(volumeIds);
  }

  scan(serverId: string, client?: IncusClientPort, signal?: AbortSignal): Promise<void> {
    return scanServerVolumes(this.deps, serverId, client, signal);
  }

  async reconcile(context: ReconcileRunContext): Promise<ReconcileOutcome> {
    if (context.intent.kind === 'volume.destroy') {
      return reconcileDestroy(this.deps, context);
    }
    if (context.intent.kind !== 'volume.ensure' && context.intent.kind !== 'volume.resize') {
      return {
        outcome: 'failed',
        failure: volumeFailure('VOLUME_INTENT_UNSUPPORTED', 'Unsupported volume intent kind'),
      };
    }
    if (!context.client) {
      throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'missing_client' });
    }
    const targetServerId = context.intent.serverId;
    if (!targetServerId) {
      return {
        outcome: 'failed',
        failure: volumeFailure('VOLUME_NOT_FOUND', 'Volume intents require a server id'),
      };
    }
    const volumeExists = await this.store.readVolumeRow(context.intent.resourceId);
    if (!volumeExists) {
      return {
        outcome: 'failed',
        failure: volumeFailure('VOLUME_NOT_FOUND', 'The desired volume no longer exists'),
      };
    }
    if (volumeExists.lifecycle_phase === 'deleting') {
      return destroyRetry(
        'VOLUME_DESTROY_PENDING',
        'Volume destroy is in progress',
        { volumeId: volumeExists.id },
      );
    }
    const row = await this.store.readVolume(context.intent.resourceId, targetServerId);
    if (!row) {
      return {
        outcome: 'failed',
        failure: volumeFailure('VOLUME_NOT_FOUND', 'The desired volume no longer exists'),
      };
    }
    this.logger.log(
      `volume=${row.id} server=${targetServerId} catalog_state=${row.catalog_state} `
      + `phase=${row.lifecycle_phase}`,
    );
    const attachments = await this.store.readAttachments(row.id, row.target_server_id);
    let actual: StorageVolume | undefined;
    try {
      actual = (await context.client.getStorageVolume(
        row.placement_pool_name,
        'custom',
        row.incus_name,
      )).metadata;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    if (!actual) {
      if (context.intent.kind === 'volume.resize' && row.shared_backend_id) {
        return { outcome: 'succeeded', observedRevision: row.revision };
      }
      actual = await adoptOrCreate(this.deps, context, row);
      if (!actual) {
        const failure = volumeFailure(
          context.intent.attemptCount >= VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS
            ? 'VOLUME_CATALOG_ADOPT_FAILED'
            : 'VOLUME_CATALOG_ADOPT_PENDING',
          context.intent.attemptCount >= VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS
            ? 'Incus did not adopt the existing CephFS directory into this daemon catalog'
            : 'Incus has not adopted the existing CephFS directory into this catalog',
          { volumeId: row.id, serverId: targetServerId },
        );
        return context.intent.attemptCount >= VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS
          ? { outcome: 'failed', failure }
          : { outcome: 'retry', failure };
      }
    }

    return alignSizeAndShifted(this.deps, context, row, actual, attachments);
  }
}
