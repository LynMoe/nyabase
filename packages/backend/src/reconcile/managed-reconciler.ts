import type { IncusClientPort } from '../incus/index.js';
import type {
  IntentFailure,
  IntentRecord,
  IntentResource,
  PhysicalSettlement,
} from './intent.repository.js';
import type { LeaseGuard, ReconcileClaim } from './reconcile-claim.repository.js';
import { intentFailure } from './intent-model.js';

export interface ReconcileRunContext {
  readonly intent: IntentRecord;
  readonly client?: IncusClientPort;
  readonly claim: ReconcileClaim;
  readonly lease: LeaseGuard;
  readonly signal: AbortSignal;
}

export interface ReconcileOutcome {
  readonly outcome: 'succeeded' | 'retry' | 'failed';
  readonly observedRevision?: number;
  readonly failure?: IntentFailure;
  readonly retryAfterMs?: number;
  readonly stale?: boolean;
}

/** A terminal `failed` outcome carrying an intent failure. */
export function failedOutcome(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): ReconcileOutcome {
  return { outcome: 'failed', failure: intentFailure(code, message, details) };
}

/** Who owns a resource (null: nobody, operator-only). */
export interface ResourceAuthority {
  readonly ownerId: string | null;
}

/**
 * A domain-owned reconciler. The engine only knows this interface; every
 * resource type writes its own status columns through the last three methods.
 */
export interface ManagedReconciler {
  readonly resourceType: IntentResource;
  supports(intent: IntentRecord): boolean;
  reconcile(context: ReconcileRunContext): Promise<ReconcileOutcome>;
  scan?(serverId: string, client: IncusClientPort, signal: AbortSignal): Promise<void>;
  /** True when the resource is parked until a user retry. */
  needsAttention(resourceId: string): Promise<boolean>;
  markSucceeded(resourceId: string, revision: number): Promise<void>;
  /** `attention` parks the resource; otherwise the failure is only recorded. */
  markFailure(resourceId: string, failure: IntentFailure, attention: boolean): Promise<void>;
  /**
   * Optional override of how a finished intent is settled. The default settles
   * every pending intent of the resource up to the observed revision; a domain
   * overrides it when some of its intents need their own completion proof.
   */
  settle?(
    intent: IntentRecord,
    observedRevision: number,
    settlement: PhysicalSettlement,
  ): Promise<void>;
  /** Answers every requested id; missing resources have no owner. */
  resourceAuthorities(resourceIds: readonly string[]): Promise<Map<string, ResourceAuthority>>;
}

/** Server state the engine needs, implemented by the servers module. */
export interface ServerHealthPort {
  /** False when a server intent was superseded by a newer server revision. */
  isCurrentServerIntent(intent: IntentRecord): Promise<boolean>;
  markServer(
    serverId: string,
    status: 'online' | 'unreachable' | 'unknown',
    error?: string,
    expectedRevision?: number,
  ): Promise<void>;
  isServerOnline(serverId: string): Promise<boolean>;
  listOnlineServerIds(): Promise<readonly string[]>;
  /** Refreshes observed capacity (GPU health, storage pool usage) for one server. */
  refreshInventory(serverId: string, client: IncusClientPort, signal: AbortSignal): Promise<void>;
}
