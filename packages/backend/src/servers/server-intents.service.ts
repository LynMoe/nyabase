import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { IntentKind, IntentResourceType } from '@nyabase/common';
import type { Kysely } from 'kysely';
import { EphemeralStore } from '../platform/ephemeral-store.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { IntentRepository, type IntentRecord } from '../reconcile/intent.repository.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function containsTrustToken(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsTrustToken);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => {
    if (key === 'trustTokenRef') return false;
    const normalizedKey = key.replaceAll('_', '').replaceAll('-', '').toLowerCase();
    if (normalizedKey === 'token' || normalizedKey.includes('trusttoken')) return true;
    return containsTrustToken(child);
  });
}

/**
 * A server.connect intent is persisted and shown in history, so it may only
 * carry an opaque reference to the one-time trust token, never the token.
 */
export function assertPersistableConnectRequest(request: Record<string, unknown>): void {
  const reference = request.trustTokenRef;
  if (typeof reference !== 'string' || !UUID_RE.test(reference)) {
    throw new Error('Server connect intents require a persistable trust-token reference');
  }
  if (containsTrustToken(request)) {
    throw new Error('Server connect intents cannot persist a trust token');
  }
}

export interface CreateServerConnectIntentInput {
  readonly serverId: string;
  readonly trustToken: string;
  readonly expectedServerCertFingerprint?: string;
  readonly targetRevision: number;
  readonly requestedBy?: string | null;
}

@Injectable()
export class ServerConnectIntentService {
  constructor(
    private readonly intents: IntentRepository,
    private readonly ephemeral: EphemeralStore,
  ) {}

  async create(input: CreateServerConnectIntentInput): Promise<IntentRecord> {
    const reference = this.ephemeral.storeTrustToken(
      input.serverId,
      input.trustToken,
    );
    const request = {
      trustTokenRef: reference,
      ...(input.expectedServerCertFingerprint
        ? { expectedServerCertFingerprint: input.expectedServerCertFingerprint }
        : {}),
    };
    assertPersistableConnectRequest(request);
    return this.intents.createPending({
      kind: IntentKind.ServerConnect,
      resourceType: IntentResourceType.Server,
      resourceId: input.serverId,
      serverId: input.serverId,
      requestedBy: input.requestedBy,
      targetRevision: input.targetRevision,
      request,
    });
  }
}

@Injectable()
export class ServerPreflightIntentService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly intents: IntentRepository,
  ) {}

  async create(
    serverId: string,
    actorId: string,
    expectedRevision: number,
    poolId: string,
    probeAddress: string,
  ): Promise<IntentRecord> {
    const server = await this.database.selectFrom('infra.servers')
      .select(['revision'])
      .where('id', '=', serverId)
      .executeTakeFirst();
    if (!server) throw new NotFoundException('Server not found');
    if (Number(server.revision) !== expectedRevision) {
      throw new ConflictException({ code: 'REVISION_CONFLICT' });
    }
    const pool = await this.database.selectFrom('infra.storage_pools')
      .select(['incus_name', 'server_id', 'registered'])
      .where('id', '=', poolId)
      .executeTakeFirst();
    if (!pool || pool.server_id !== serverId || !pool.registered) {
      throw new ConflictException({ code: 'MISSING_STORAGE_POOL' });
    }
    return this.intents.createPending({
      kind: IntentKind.ServerPreflight,
      resourceType: IntentResourceType.Server,
      resourceId: serverId,
      serverId,
      requestedBy: actorId,
      targetRevision: expectedRevision,
      request: {
        preflight: {
          probePoolName: pool.incus_name,
          probeAddress,
        },
      },
    });
  }
}
