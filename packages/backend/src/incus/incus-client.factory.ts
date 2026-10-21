import { Inject, Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import {
  IncusClient,
  IncusError,
  normalizeCertificateFingerprint,
  type IncusClientPort,
} from './index.js';
import { IncusClientIdentityService, type IncusClientIdentity } from './incus-client-identity.service.js';
import type { Kysely, Selectable } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import type { InfrastructureServerTable } from '../platform/persistence-pg/infrastructure-database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';

export const INCUS_CLIENT_FACTORY = Symbol('INCUS_CLIENT_FACTORY');

export interface IncusClientFactory {
  get(
    serverId: string,
    options?: {
      readonly expectedFingerprint?: string;
    },
  ): Promise<IncusClientPort>;
  listServerIds(): Promise<readonly string[]>;
}

type ServerRow = Pick<
  Selectable<InfrastructureServerTable>,
  'id' | 'api_endpoint' | 'server_cert_fingerprint'
>;
interface ClientFactoryOptions {
  readonly expectedFingerprint?: string;
}

/**
 * Creates mTLS Incus clients presenting the control plane's single generated
 * client identity (see IncusClientIdentityService). The server CA still comes
 * from deployment configuration.
 */
@Injectable()
export class DatabaseIncusClientFactory implements IncusClientFactory {
  private readonly clients = new Map<string, IncusClient>();

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly config: NyabaseConfigService,
    private readonly identity: IncusClientIdentityService,
  ) {}

  async listServerIds(): Promise<readonly string[]> {
    const rows = await this.database
      .selectFrom('infra.servers')
      .select('id')
      .execute();
    return rows.map((row) => row.id);
  }

  async get(serverId: string, options: ClientFactoryOptions = {}): Promise<IncusClient> {
    const server = await this.readServer(serverId);
    const expectedFingerprint = options.expectedFingerprint
      ?? server.server_cert_fingerprint
      ?? undefined;
    const cached = this.clients.get(serverId);
    if (
      cached
      && (
        !expectedFingerprint
        || cached.pinnedFingerprint === normalizeCertificateFingerprint(expectedFingerprint)
      )
    ) {
      return cached;
    }
    const client = await this.createClient(
      server,
      await this.identity.get(),
      expectedFingerprint,
    );
    this.clients.set(serverId, client);
    return client;
  }

  private async readServer(serverId: string): Promise<ServerRow> {
    const server = await this.database
      .selectFrom('infra.servers')
      .select(['id', 'api_endpoint', 'server_cert_fingerprint'])
      .where('id', '=', serverId)
      .executeTakeFirst();
    if (!server) {
      throw new IncusError('SERVER_UNREACHABLE', 'retry', {
        serverId,
        reason: 'server_not_found',
      });
    }
    return server;
  }

  private async createClient(
    server: ServerRow,
    identity: IncusClientIdentity,
    expectedFingerprint: string | undefined,
  ): Promise<IncusClient> {
    const endpoint = new URL(server.api_endpoint);
    const ca = this.readCa();
    const normalizedExpected = expectedFingerprint
      ? normalizeCertificateFingerprint(expectedFingerprint)
      : undefined;
    if (!normalizedExpected) {
      throw new IncusError('TLS_PIN_MISMATCH', 'managed_failure', {
        serverId: server.id,
        reason: 'expected_server_fingerprint_missing',
      });
    }
    const storedFingerprint = server.server_cert_fingerprint
      ? normalizeCertificateFingerprint(server.server_cert_fingerprint)
      : undefined;
    const client = new IncusClient({
      endpoint: endpoint.toString(),
      allowedHosts: [endpoint.hostname],
      tls: {
        cert: identity.certificatePem,
        key: identity.privateKeyPem,
        ca,
        fingerprint: storedFingerprint,
        expectedFingerprint: normalizedExpected,
        onFirstFingerprint: storedFingerprint
          ? undefined
          : (fingerprint) => this.persistFirstFingerprint(server.id, fingerprint),
      },
      timeouts: this.requestTimeouts(),
      operationWaitTimeoutMs: this.config.get<number>('incus.operationWaitTimeoutMs'),
    });
    return client;
  }

  private requestTimeouts(): {
    readonly connectMs: number;
    readonly headersMs: number;
    readonly bodyMs: number;
    readonly totalMs: number;
  } {
    const timeout = this.config.get<number>('incus.requestTimeoutMs');
    return {
      connectMs: timeout,
      headersMs: timeout,
      bodyMs: timeout,
      totalMs: timeout,
    };
  }

  private async persistFirstFingerprint(serverId: string, fingerprint: string): Promise<void> {
    const updated = await this.database
      .updateTable('infra.servers')
      .set({ server_cert_fingerprint: fingerprint })
      .where('id', '=', serverId)
      .where((expression) => expression.or([
        expression('server_cert_fingerprint', 'is', null),
        expression('server_cert_fingerprint', '=', ''),
      ]))
      .returning('server_cert_fingerprint')
      .executeTakeFirst();
    const stored = updated?.server_cert_fingerprint
      ?? await this.database
        .selectFrom('infra.servers')
        .select('server_cert_fingerprint')
        .where('id', '=', serverId)
        .executeTakeFirst()
        .then((row) => row?.server_cert_fingerprint);
    if (
      !stored
      || normalizeCertificateFingerprint(stored) !== normalizeCertificateFingerprint(fingerprint)
    ) {
      throw new IncusError('TLS_PIN_MISMATCH', 'managed_failure', { serverId });
    }
  }

  private readCa(): string {
    const fileValue = this.config.get<string>('incus.caFile');
    const file = typeof fileValue === 'string' ? fileValue.trim() : '';
    if (file) {
      try {
        const value = readFileSync(file, 'utf8');
        if (value.trim()) return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const inlineValue = this.config.get<string>('incus.caPem');
    const inline = typeof inlineValue === 'string' ? inlineValue.trim() : '';
    if (inline) return inline;
    throw new IncusError('TLS_ERROR', 'retry', {
      reason: 'incus.caFile_not_injected',
    });
  }
}
