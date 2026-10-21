import { Injectable } from '@nestjs/common';
import { IntentKind, IntentResourceType } from '@nyabase/common';
import {
  IntentRepository,
  type IntentRecord,
} from '../reconcile/intent.repository.js';
import { EphemeralStore } from '../platform/ephemeral-store.js';

export interface CreateServerConnectIntentInput {
  readonly serverId: string;
  readonly trustToken: string;
  readonly expectedServerCertFingerprint?: string;
  readonly targetGeneration: number;
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
    return this.intents.createPending({
      kind: IntentKind.ServerConnect,
      resourceType: IntentResourceType.Server,
      resourceId: input.serverId,
      serverId: input.serverId,
      requestedBy: input.requestedBy,
      targetGeneration: input.targetGeneration,
      request: {
        trustTokenRef: reference,
        ...(input.expectedServerCertFingerprint
          ? { expectedServerCertFingerprint: input.expectedServerCertFingerprint }
          : {}),
      },
    });
  }
}
