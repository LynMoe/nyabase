import { Injectable } from '@nestjs/common';
import { AgentTaskKind, type RemoteFsMountSpec } from '@nyabase/common';
import type { AgentTaskRecord } from '../domain/domain-records.js';
import { RemoteFsSecretCryptoService } from '../remote-fs/remote-fs-secret-crypto.service.js';

@Injectable()
export class AgentTaskPayloadCodecService {
  constructor(private remoteFsSecrets: RemoteFsSecretCryptoService) {}

  forDispatch(task: AgentTaskRecord): unknown {
    return this.forWirePayload(task.kind, task.payloadJson);
  }

  forWirePayload(kind: AgentTaskKind, storedPayload: unknown): unknown {
    const payload = this.clone(storedPayload);
    if (
      kind !== AgentTaskKind.RemoteFsEnsure
      && kind !== AgentTaskKind.RemoteFsAbsent
    ) {
      return payload;
    }
    return this.decryptRemoteFsSecret(payload);
  }

  forRemoteFsBootstrap(specs: readonly RemoteFsMountSpec[]): RemoteFsMountSpec[] {
    return specs.map((spec) =>
      this.decryptRemoteFsSecret(this.clone(spec)) as RemoteFsMountSpec);
  }

  private decryptRemoteFsSecret(payload: unknown): unknown {
    const record = this.record(payload);
    const params = this.record(record?.params);
    if (!params || typeof params.secret !== 'string') return payload;
    params.secret = this.remoteFsSecrets.decryptIfEncrypted(params.secret);
    return payload;
  }

  private clone(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((entry) => this.clone(entry));
    const record = this.record(value);
    if (!record) return value;
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, this.clone(entry)]),
    );
  }

  private record(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }
}
