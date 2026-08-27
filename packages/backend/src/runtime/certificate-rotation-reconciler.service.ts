import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  AuditAction,
  CertificateState,
  CertificateTrustState,
  IntentResourceType,
  ServerStatus,
} from '@nyabase/common';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type {
  IncusClientCertificateTable,
  IncusClientCertificateTrustTable,
} from '../system-settings/system-settings-database.types.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { lockServerOnboarding } from '../infrastructure/infrastructure.repository.js';
import { IncusError, requestAndWait, type IncusClientPort } from '../incus/index.js';
import { AuditService } from '../audit/audit.service.js';
import {
  INCUS_CLIENT_FACTORY,
  type IncusClientFactory,
  type ManagedReconciler,
  type ReconcileOutcome,
  type ReconcileRunContext,
} from './reconcile-worker.service.js';
import type { IntentFailure, IntentRecord } from './intent.repository.js';

type CertificateRow = Selectable<IncusClientCertificateTable>;
type TrustRow = Selectable<IncusClientCertificateTrustTable>;

const MAX_NON_ONLINE_ATTEMPTS = 3;
const ATTEMPT_PREFIX = /^\[attempts=(\d+)\]\s*/;

interface CertificateFactory extends IncusClientFactory {
  getForCertificate?(serverId: string, certificateId: string): Promise<IncusClientPort>;
  invalidate?(serverId?: string): void;
}

interface ServerSnapshot {
  readonly id: string;
  readonly status: string;
}

interface RotationSnapshot {
  readonly active: CertificateRow | undefined;
  readonly candidate: CertificateRow | undefined;
  readonly retired: CertificateRow | undefined;
  readonly servers: readonly ServerSnapshot[];
  readonly activeTrusts: readonly TrustRow[];
  readonly candidateTrusts: readonly TrustRow[];
  readonly retiredTrusts: readonly TrustRow[];
}

function rotationFailure(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): IntentFailure {
  return { code, message, details };
}

function generation(value: string | number | bigint): number {
  return Number(value);
}

function isVerified(state: TrustRow['state'] | undefined): boolean {
  return state === CertificateTrustState.Verified;
}

function isOnline(status: string): boolean {
  return status === ServerStatus.Online;
}

function parseAttempts(lastError: string | null | undefined): number {
  const match = lastError?.match(ATTEMPT_PREFIX);
  return match ? Number(match[1]) : 0;
}

function formatAttempts(attempts: number, message: string): string {
  return `[attempts=${attempts}] ${message}`.slice(0, 4096);
}

function trustByServerId(trusts: readonly TrustRow[]): Map<string, TrustRow> {
  return new Map(trusts.map((trust) => [trust.server_id, trust]));
}

/**
 * Certificate rotation is a global intent. A candidate is staged, trusted on
 * currently-online Incus servers, then activated. Unreachable and never-online
 * servers must not stall fleet cutover. Incus HTTP never runs inside the
 * lockServerOnboarding transaction — PostgreSQL idle-in-transaction timeout
 * is 30s and a hung Incus call would abort the lock.
 */
@Injectable()
export class CertificateRotationReconciler implements ManagedReconciler {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    @Optional()
    @Inject(INCUS_CLIENT_FACTORY)
    private readonly clients?: CertificateFactory,
    @Optional() private readonly audit?: AuditService,
  ) {}

  supports(intent: IntentRecord): boolean {
    return intent.resourceType === IntentResourceType.CertificateRotation;
  }

  async reconcile(context: ReconcileRunContext): Promise<ReconcileOutcome> {
    if (!this.supports(context.intent)) {
      return {
        outcome: 'failed',
        failure: rotationFailure(
          'CERTIFICATE_ROTATION_INVALID_INTENT',
          'The certificate rotation reconciler received an incompatible intent',
        ),
      };
    }

    const clients = this.clients;
    if (!clients?.get) {
      return {
        outcome: 'retry',
        failure: rotationFailure(
          'CERTIFICATE_ROTATION_DEPENDENCY_UNAVAILABLE',
          'The Incus client factory is unavailable for certificate verification',
        ),
        retryAfterMs: 30_000,
      };
    }

    const targetGeneration = context.intent.targetGeneration;
    const snapshot = await this.snapshot(targetGeneration);
    if (!snapshot.active) {
      return {
        outcome: 'failed',
        failure: rotationFailure(
          'CERTIFICATE_CONFIGURATION_MISSING',
          'No active Incus client certificate is configured',
        ),
      };
    }

    if (generation(snapshot.active.generation) >= targetGeneration) {
      const revoke = await this.revokeRetired(snapshot, clients, context.intent);
      if (revoke.retry) {
        return {
          outcome: 'retry',
          failure: rotationFailure(
            'CERTIFICATE_ROTATION_REVOKE_PENDING',
            'The previous Incus client certificate has not been revoked on every verified server',
            { pendingServerCount: revoke.pendingServerCount },
          ),
          retryAfterMs: 30_000,
        };
      }
      return {
        outcome: 'succeeded',
        observedGeneration: targetGeneration,
      };
    }

    if (!snapshot.candidate) {
      return {
        outcome: 'retry',
        failure: rotationFailure(
          'CERTIFICATE_ROTATION_CANDIDATE_MISSING',
          'The next Incus client certificate has not been staged',
          { targetGeneration },
        ),
        retryAfterMs: 30_000,
      };
    }

    await this.trustReachableServers(snapshot, clients, context.intent);
    const activated = await this.tryActivate(snapshot.active.id, snapshot.candidate.id);
    if (!activated.complete) {
      return {
        outcome: 'retry',
        failure: rotationFailure(
          'CERTIFICATE_ROTATION_TRUST_PENDING',
          'The staged Incus client certificate is not verified by every currently-online server',
          { pendingServerCount: activated.pendingOnlineCount },
        ),
        retryAfterMs: 30_000,
      };
    }

    clients.invalidate?.();
    const after = await this.snapshot(targetGeneration);
    const revoke = await this.revokeRetired(after, clients, context.intent);
    if (revoke.retry) {
      return {
        outcome: 'retry',
        failure: rotationFailure(
          'CERTIFICATE_ROTATION_REVOKE_PENDING',
          'The previous Incus client certificate has not been revoked on every verified server',
          { pendingServerCount: revoke.pendingServerCount },
        ),
        retryAfterMs: 30_000,
      };
    }
    return {
      outcome: 'succeeded',
      observedGeneration: targetGeneration,
    };
  }

  /**
   * Short transaction: advisory lock, read active/candidate/retired plus
   * server status, commit. Callers must not perform Incus HTTP here.
   */
  private async snapshot(targetGeneration: number): Promise<RotationSnapshot> {
    return this.database.transaction().execute(async (transaction) => {
      await lockServerOnboarding(transaction);
      const active = await transaction
        .selectFrom('system.incus_client_certificates')
        .selectAll()
        .where('state', '=', CertificateState.Active)
        .forUpdate()
        .executeTakeFirst();
      const servers = await transaction
        .selectFrom('infra.servers')
        .select(['id', 'status'])
        .orderBy('id')
        .execute();
      const candidate = await transaction
        .selectFrom('system.incus_client_certificates')
        .selectAll()
        .where('generation', '=', String(targetGeneration))
        .where('state', '=', CertificateState.Staged)
        .forUpdate()
        .executeTakeFirst();
      const retired = await transaction
        .selectFrom('system.incus_client_certificates')
        .selectAll()
        .where('state', '=', CertificateState.Retired)
        .orderBy('generation', 'desc')
        .executeTakeFirst();
      const activeTrusts = active
        ? await this.loadTrusts(transaction, active.id)
        : [];
      const candidateTrusts = candidate
        ? await this.loadTrusts(transaction, candidate.id)
        : [];
      const retiredTrusts = retired
        ? await this.loadTrusts(transaction, retired.id)
        : [];
      return {
        active,
        candidate,
        retired,
        servers,
        activeTrusts,
        candidateTrusts,
        retiredTrusts,
      };
    });
  }

  private loadTrusts(
    executor: Transaction<NyabaseDatabase>,
    certificateId: string,
  ): Promise<TrustRow[]> {
    return executor
      .selectFrom('system.incus_client_certificate_trusts')
      .selectAll()
      .where('certificate_id', '=', certificateId)
      .execute();
  }

  private async trustReachableServers(
    snapshot: RotationSnapshot,
    clients: CertificateFactory,
    intent: IntentRecord,
  ): Promise<void> {
    const candidate = snapshot.candidate;
    if (!candidate) return;
    const trusts = trustByServerId(snapshot.candidateTrusts);
    for (const server of snapshot.servers) {
      const trust = trusts.get(server.id);
      if (isVerified(trust?.state)) continue;
      const attempts = parseAttempts(trust?.last_error);
      if (!isOnline(server.status) && attempts >= MAX_NON_ONLINE_ATTEMPTS) {
        continue;
      }
      if (!isOnline(server.status) && server.status !== ServerStatus.Unreachable) {
        await this.ensureTrustRow(candidate.id, server.id);
        if (!trust?.last_error) {
          await this.markTrustFailure(
            candidate.id,
            server.id,
            formatAttempts(
              Math.max(attempts, 1),
              `needs_attention: server status is ${server.status}`,
            ),
          );
        }
        continue;
      }
      try {
        await this.ensureTrustRow(candidate.id, server.id);
        await this.trustAndVerify(clients, server.id, candidate, trust, intent);
      } catch (error) {
        const nextAttempts = attempts + 1;
        await this.markTrustFailure(
          candidate.id,
          server.id,
          formatAttempts(
            nextAttempts,
            `${!isOnline(server.status) && nextAttempts >= MAX_NON_ONLINE_ATTEMPTS
              ? 'needs_attention: '
              : ''}${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    }
  }

  private async tryActivate(
    activeId: string,
    candidateId: string,
  ): Promise<{ readonly complete: boolean; readonly pendingOnlineCount: number }> {
    return this.database.transaction().execute(async (transaction) => {
      await lockServerOnboarding(transaction);
      const active = await transaction
        .selectFrom('system.incus_client_certificates')
        .selectAll()
        .where('id', '=', activeId)
        .where('state', '=', CertificateState.Active)
        .forUpdate()
        .executeTakeFirst();
      const candidate = await transaction
        .selectFrom('system.incus_client_certificates')
        .selectAll()
        .where('id', '=', candidateId)
        .where('state', '=', CertificateState.Staged)
        .forUpdate()
        .executeTakeFirst();
      if (!active || !candidate) {
        return { complete: false, pendingOnlineCount: 0 };
      }
      const servers = await transaction
        .selectFrom('infra.servers')
        .select(['id', 'status'])
        .orderBy('id')
        .execute();
      const trusts = trustByServerId(await this.loadTrusts(transaction, candidate.id));
      let pendingOnlineCount = 0;
      for (const server of servers) {
        if (!isOnline(server.status)) continue;
        if (isVerified(trusts.get(server.id)?.state)) continue;
        pendingOnlineCount += 1;
      }
      if (pendingOnlineCount > 0) {
        return { complete: false, pendingOnlineCount };
      }
      await this.activateCandidate(transaction, active, candidate);
      return { complete: true, pendingOnlineCount: 0 };
    });
  }

  private async revokeRetired(
    snapshot: RotationSnapshot,
    clients: CertificateFactory,
    intent: IntentRecord,
  ): Promise<{ readonly retry: boolean; readonly pendingServerCount: number }> {
    const retired = snapshot.retired;
    const active = snapshot.active;
    if (!retired || !active || retired.id === active.id) {
      return { retry: false, pendingServerCount: 0 };
    }
    if (generation(retired.generation) >= generation(active.generation)) {
      return { retry: false, pendingServerCount: 0 };
    }
    const verifiedNew = new Set(
      snapshot.activeTrusts
        .filter((trust) => isVerified(trust.state))
        .map((trust) => trust.server_id),
    );
    const oldTrusts = trustByServerId(snapshot.retiredTrusts);
    let pendingServerCount = 0;
    for (const server of snapshot.servers) {
      if (!verifiedNew.has(server.id)) continue;
      const oldTrust = oldTrusts.get(server.id);
      if (oldTrust?.state === CertificateTrustState.Revoked) continue;
      const attempts = parseAttempts(oldTrust?.last_error);
      if (
        oldTrust?.state === CertificateTrustState.CleanupFailed
        && attempts >= MAX_NON_ONLINE_ATTEMPTS
      ) {
        continue;
      }
      try {
        const client = await clients.get(server.id);
        if (!client.deleteClientCertificate) {
          throw new IncusError('TLS_ERROR', 'retry', {
            serverId: server.id,
            reason: 'delete_client_certificate_unavailable',
          });
        }
        await this.auditIncusMutate(intent, {
          method: 'DELETE',
          path: `/1.0/certificates/${retired.fingerprint}`,
          serverId: server.id,
        });
        await client.deleteClientCertificate(retired.fingerprint);
        await this.ensureTrustRow(retired.id, server.id);
        await this.markTrustState(
          retired.id,
          server.id,
          CertificateTrustState.Revoked,
        );
      } catch (error) {
        const nextAttempts = attempts + 1;
        await this.ensureTrustRow(retired.id, server.id);
        await this.markTrustState(
          retired.id,
          server.id,
          CertificateTrustState.CleanupFailed,
          formatAttempts(
            nextAttempts,
            error instanceof Error ? error.message : String(error),
          ),
        );
        if (nextAttempts < MAX_NON_ONLINE_ATTEMPTS) {
          pendingServerCount += 1;
        }
      }
    }
    return { retry: pendingServerCount > 0, pendingServerCount };
  }

  private async ensureTrustRow(
    certificateId: string,
    serverId: string,
  ): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto('system.incus_client_certificate_trusts')
        .values({
          certificate_id: certificateId,
          server_id: serverId,
          state: CertificateTrustState.Pending,
          last_error: null,
          observed_at: null,
        })
        .onConflict((conflict) => conflict.columns(['certificate_id', 'server_id']).doNothing())
        .execute();
    });
  }

  private async trustAndVerify(
    clients: CertificateFactory,
    serverId: string,
    candidate: CertificateRow,
    trust: TrustRow | undefined,
    intent: IntentRecord,
  ): Promise<void> {
    if (!clients.getForCertificate) {
      throw new IncusError('TLS_ERROR', 'retry', {
        serverId,
        reason: 'candidate_client_factory_unavailable',
      });
    }
    const activeClient = await clients.get(serverId);
    if (
      trust?.state !== CertificateTrustState.Trusted
      && trust?.state !== CertificateTrustState.Verified
    ) {
      await this.auditIncusMutate(intent, {
        method: 'POST',
        path: '/1.0/certificates',
        serverId,
      });
      await requestAndWait(
        activeClient,
        (options) =>
          activeClient.trustCertificate(
            candidate.certificate_pem,
            `nyabase-${serverId.replaceAll('-', '')}`,
            options,
          ),
        {},
      );
      await this.markTrustState(candidate.id, serverId, CertificateTrustState.Trusted);
    }
    const candidateClient = await clients.getForCertificate(serverId, candidate.id);
    await candidateClient.getServer();
    await this.markTrustState(candidate.id, serverId, CertificateTrustState.Verified);
  }

  private async markTrustState(
    certificateId: string,
    serverId: string,
    state: CertificateTrustState,
    lastError: string | null = null,
  ): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable('system.incus_client_certificate_trusts')
        .set({
          state,
          last_error: lastError,
          observed_at: state === CertificateTrustState.Verified
            || state === CertificateTrustState.Revoked
            ? new Date()
            : null,
        })
        .where('certificate_id', '=', certificateId)
        .where('server_id', '=', serverId)
        .execute();
    });
  }

  private async markTrustFailure(
    certificateId: string,
    serverId: string,
    message: string,
  ): Promise<void> {
    await this.markTrustState(
      certificateId,
      serverId,
      CertificateTrustState.Pending,
      message,
    );
  }

  private async activateCandidate(
    transaction: Transaction<NyabaseDatabase>,
    active: CertificateRow,
    candidate: CertificateRow,
  ): Promise<void> {
    await transaction
      .updateTable('system.incus_client_certificates')
      .set({
        state: CertificateState.Retired,
        retired_at: new Date(),
      })
      .where('id', '=', active.id)
      .where('state', '=', CertificateState.Active)
      .execute();
    const result = await transaction
      .updateTable('system.incus_client_certificates')
      .set({
        state: CertificateState.Active,
        activated_at: new Date(),
        retired_at: null,
      })
      .where('id', '=', candidate.id)
      .where('state', '=', CertificateState.Staged)
      .returning('id')
      .executeTakeFirst();
    if (!result) {
      throw new IncusError('ETAG_CONFLICT', 'retry', {
        reason: 'certificate_candidate_changed',
      });
    }
  }

  private async auditIncusMutate(
    intent: IntentRecord,
    detail: {
      readonly method: string;
      readonly path: string;
      readonly serverId: string;
    },
  ): Promise<void> {
    if (!this.audit) return;
    await this.audit.log(
      intent.requestedBy,
      AuditAction.IncusMutate,
      intent.resourceId,
      intent.resourceType,
      {
        method: detail.method,
        path: detail.path,
        serverId: detail.serverId,
        intentId: intent.id,
      },
    );
  }
}
