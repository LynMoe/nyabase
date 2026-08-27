import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  IncusClient,
  IncusError,
  normalizeCertificateFingerprint,
  type IncusClientPort,
} from '../incus/index.js';
import {
  decryptPrivateKey,
  encryptPrivateKey,
  validateCertificateKeyPair,
} from '../incus/incus-credentials.js';
import type { IncusClientFactory } from './reconcile-worker.service.js';
import type { Kysely, Selectable } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import type { InfrastructureServerTable } from '../infrastructure/infrastructure-database.types.js';
import type { IncusClientCertificateTable } from '../system-settings/system-settings-database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';

type ServerRow = Pick<
  Selectable<InfrastructureServerTable>,
  'id' | 'api_endpoint' | 'server_cert_fingerprint'
>;
type CertificateRow = Selectable<IncusClientCertificateTable>;

interface CachedClient {
  readonly generation: string;
  readonly client: IncusClient;
}

interface ClientFactoryOptions {
  readonly expectedFingerprint?: string;
}

/**
 * Creates mTLS Incus clients from the encrypted database certificate or the
 * explicitly injected deployment secret files. The deployment files are only
 * used to bootstrap generation one; subsequent clients use the encrypted row.
 */
@Injectable()
export class DatabaseIncusClientFactory implements IncusClientFactory {
  private readonly clients = new Map<string, CachedClient>();

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly config: NyabaseConfigService,
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
    const active = await this.ensureActiveCertificate();
    const expectedFingerprint = options.expectedFingerprint
      ?? server.server_cert_fingerprint
      ?? undefined;
    const cached = this.clients.get(serverId);
    if (
      cached
      && cached.generation === String(active.generation)
      && (
        !expectedFingerprint
        || cached.client.pinnedFingerprint === normalizeCertificateFingerprint(expectedFingerprint)
      )
    ) {
      return cached.client;
    }
    const client = await this.createClient(server, active, expectedFingerprint);
    this.clients.set(serverId, {
      generation: String(active.generation),
      client,
    });
    return client;
  }

  async getForCertificate(serverId: string, certificateId: string): Promise<IncusClient> {
    const server = await this.readServer(serverId);
    const certificate = await this.database
      .selectFrom('system.incus_client_certificates')
      .selectAll()
      .where('id', '=', certificateId)
      .where('state', '=', 'staged')
      .executeTakeFirst();
    if (!certificate) {
      throw new IncusError('TLS_ERROR', 'retry', {
        serverId,
        certificateId,
        reason: 'staged_certificate_not_found',
      });
    }
    if (!server.server_cert_fingerprint) {
      throw new IncusError('TLS_PIN_MISMATCH', 'managed_failure', {
        serverId,
        reason: 'server_fingerprint_not_configured',
      });
    }
    return this.createClient(server, certificate, server.server_cert_fingerprint);
  }

  invalidate(serverId?: string): void {
    if (serverId) {
      this.clients.delete(serverId);
      return;
    }
    this.clients.clear();
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

  private async ensureActiveCertificate(): Promise<CertificateRow> {
    const existing = await this.activeCertificate();
    if (existing) return existing;

    const certificatePem = this.readBootstrapSecret(
      'incus.clientCertificateFile',
      'incus.clientCertificatePem',
    );
    const privateKeyPem = this.readBootstrapSecret(
      'incus.clientPrivateKeyFile',
      'incus.clientPrivateKeyPem',
    );
    const metadata = validateCertificateKeyPair(certificatePem, privateKeyPem);
    const secret = this.keyEncryptionSecret();
    await this.database
      .insertInto('system.incus_client_certificates')
      .values({
        id: randomUUID(),
        generation: 1,
        certificate_pem: certificatePem,
        encrypted_private_key: encryptPrivateKey(privateKeyPem, secret),
        fingerprint: metadata.fingerprint,
        not_before: metadata.notBefore,
        not_after: metadata.notAfter,
        state: 'active',
        created_by: null,
        activated_at: new Date(),
        retired_at: null,
      })
      .onConflict((conflict) => conflict.column('generation').doNothing())
      .execute();
    const bootstrapped = await this.activeCertificate();
    if (!bootstrapped) {
      throw new IncusError('TLS_ERROR', 'retry', {
        reason: 'active_certificate_bootstrap_race',
      });
    }
    return bootstrapped;
  }

  private activeCertificate(): Promise<CertificateRow | undefined> {
    return this.database
      .selectFrom('system.incus_client_certificates')
      .selectAll()
      .where('state', '=', 'active')
      .executeTakeFirst();
  }

  private async createClient(
    server: ServerRow,
    certificate: CertificateRow,
    expectedFingerprint: string | undefined,
  ): Promise<IncusClient> {
    const endpoint = new URL(server.api_endpoint);
    const privateKeyPem = decryptPrivateKey(
      certificate.encrypted_private_key,
      this.keyEncryptionSecret(),
    );
    const ca = this.readBootstrapSecret('incus.caFile', 'incus.caPem');
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
        cert: certificate.certificate_pem,
        key: privateKeyPem,
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

  private readBootstrapSecret(fileKey: string, inlineKey: string): string {
    const fileValue = this.config.get<string>(fileKey as never);
    const file = typeof fileValue === 'string' ? fileValue.trim() : '';
    if (file) {
      try {
        const value = readFileSync(file, 'utf8');
        if (value.trim()) return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const inlineValue = this.config.get<string>(inlineKey as never);
    const inline = typeof inlineValue === 'string' ? inlineValue.trim() : '';
    if (inline) return inline;
    throw new IncusError('TLS_ERROR', 'retry', {
      reason: `${fileKey}_not_injected`,
    });
  }

  private keyEncryptionSecret(): string {
    return this.config.keyEncryptionSecret();
  }
}
