import { Inject, Injectable } from '@nestjs/common';
import { IntentKind, IntentResourceType } from '@nyabase/common';
import {
  IntentRepository,
  type IntentRecord,
} from './intent.repository.js';
import {
  SERVER_TRUST_TOKEN,
  type ServerTrustTokenPort,
} from './server-preflight-reconciler.service.js';

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
    @Inject(SERVER_TRUST_TOKEN) private readonly trustTokens: ServerTrustTokenPort,
  ) {}

  async create(input: CreateServerConnectIntentInput): Promise<IntentRecord> {
    const reference = await this.trustTokens.storeTrustToken(
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
