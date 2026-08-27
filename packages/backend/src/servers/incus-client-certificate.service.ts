import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Kysely, Selectable, Transaction } from 'kysely';
import {
  AuditAction,
  Capability,
  CertificateRotationStatus,
  CertificateState,
  CertificateTrustState,
  IntentKind,
  IntentResourceType,
  IntentStatus,
  type CertificateRotationDto,
  type IncusClientCertificateDto,
} from '@nyabase/common';
import { randomUUID } from 'node:crypto';
import type {
  IncusClientCertificateTable,
  IncusClientCertificateTrustTable,
} from '../system-settings/system-settings-database.types.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { AuditService } from '../audit/audit.service.js';
import { IntentRepository } from '../runtime/intent.repository.js';
import { numberValue } from '../domain/domain-utils.js';
import {
  encryptPrivateKey,
  generateIncusClientCertificate,
  validateCertificateKeyPair,
} from '../incus/incus-credentials.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';

type CertificateRow = Selectable<IncusClientCertificateTable>;
type TrustRow = Selectable<IncusClientCertificateTrustTable>;

@Injectable()
export class IncusClientCertificateService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly access: AccessResolverService,
    private readonly audit: AuditService,
    private readonly intents: IntentRepository,
    private readonly config: NyabaseConfigService,
  ) {}

  async getActive(): Promise<IncusClientCertificateDto> {
    const certificate = await this.database
      .selectFrom('system.incus_client_certificates')
      .selectAll()
      .where('state', '=', CertificateState.Active)
      .executeTakeFirst();
    if (!certificate) {
      throw new NotFoundException('Incus client certificate is not configured');
    }
    return this.toDto(certificate, this.database);
  }

  async rotate(
    actorId: string,
    expectedGeneration: number,
  ): Promise<CertificateRotationDto> {
    const result = await this.enqueueRotation(
      actorId,
      expectedGeneration,
      { requireCapability: true },
    );
    if (!result) {
      throw new ConflictException({ code: 'ROTATION_IN_PROGRESS' });
    }
    return result;
  }

  /**
   * Enqueue a rotation for the durable system actor. Skips ManageCertificates
   * checks. Returns null when a staged candidate or pending rotate intent
   * already exists so automatic rotation cannot clobber a manual rotate.
   */
  async rotateAsSystem(
    actorId: string,
    expectedGeneration?: number,
  ): Promise<CertificateRotationDto | null> {
    return this.enqueueRotation(actorId, expectedGeneration, { requireCapability: false });
  }

  private async enqueueRotation(
    actorId: string,
    expectedGeneration: number | undefined,
    options: { readonly requireCapability: boolean },
  ): Promise<CertificateRotationDto | null> {
    const result = await this.transactions.run(async (transaction) => {
      if (options.requireCapability) {
        await this.access.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageCertificates],
        );
      }
      const certificate = await transaction
        .selectFrom('system.incus_client_certificates')
        .selectAll()
        .where('state', '=', CertificateState.Active)
        .forUpdate()
        .executeTakeFirst();
      if (!certificate) {
        throw new NotFoundException('Incus client certificate is not configured');
      }
      const generation = numberValue(certificate.generation);
      if (
        expectedGeneration !== undefined
        && generation !== expectedGeneration
      ) {
        throw new ConflictException({ code: 'GENERATION_CONFLICT' });
      }
      if (!options.requireCapability) {
        const staged = await transaction
          .selectFrom('system.incus_client_certificates')
          .select('id')
          .where('state', '=', CertificateState.Staged)
          .executeTakeFirst();
        if (staged) return null;
        const pending = await transaction
          .selectFrom('control.intents')
          .select('id')
          .where('kind', '=', IntentKind.CertificateRotate)
          .where('status', '=', IntentStatus.Pending)
          .executeTakeFirst();
        if (pending) return null;
      }
      // Abandon incomplete staged candidates so a retry cannot collide on
      // generation+1 after a previous rotate left a staged/failed row behind.
      await transaction
        .updateTable('system.incus_client_certificates')
        .set({ state: CertificateState.Failed })
        .where('state', '=', CertificateState.Staged)
        .execute();
      const maxGenerationRow = await transaction
        .selectFrom('system.incus_client_certificates')
        .select((eb) => eb.fn.max('generation').as('max_generation'))
        .executeTakeFirst();
      const maxGeneration = numberValue(maxGenerationRow?.max_generation ?? generation);
      const nextGeneration = Math.max(generation, maxGeneration) + 1;
      const material = await generateIncusClientCertificate();
      const metadata = validateCertificateKeyPair(
        material.certificatePem,
        material.privateKeyPem,
      );
      const candidate = await transaction
        .insertInto('system.incus_client_certificates')
        .values({
          id: randomUUID(),
          generation: nextGeneration,
          certificate_pem: material.certificatePem,
          encrypted_private_key: encryptPrivateKey(
            material.privateKeyPem,
            this.keyEncryptionSecret(),
          ),
          fingerprint: metadata.fingerprint,
          not_before: metadata.notBefore,
          not_after: metadata.notAfter,
          state: CertificateState.Staged,
          created_by: actorId,
          activated_at: null,
          retired_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const servers = await transaction
        .selectFrom('infra.servers')
        .select('id')
        .execute();
      if (servers.length > 0) {
        await transaction
          .insertInto('system.incus_client_certificate_trusts')
          .values(servers.map((server) => ({
            certificate_id: candidate.id,
            server_id: server.id,
            state: CertificateTrustState.Pending,
            last_error: null,
            observed_at: null,
          })))
          .execute();
      }
      const intent = await this.intents.createPending({
        id: undefined,
        kind: IntentKind.CertificateRotate,
        resourceType: IntentResourceType.CertificateRotation,
        resourceId: randomUUID(),
        requestedBy: actorId,
        targetGeneration: nextGeneration,
        request: {
          operation: 'rotate',
          expectedGeneration: generation,
        },
      }, transaction);
      await this.audit.append(
        transaction,
        actorId,
        AuditAction.RotateIncusClientCertificate,
        intent.id,
        'certificate_rotation',
        { expectedGeneration: generation, targetGeneration: nextGeneration },
      );
      return {
        intent,
        certificate: candidate,
      };
    });
    if (!result) return null;
    return {
      rotationId: result.intent.id,
      generation: result.intent.targetGeneration,
      status: CertificateRotationStatus.Pending,
      certificate: await this.toDto(result.certificate, this.database),
      failureCode: null,
    };
  }

  async rotation(rotationId: string): Promise<CertificateRotationDto> {
    const intent = await this.intents.findById(rotationId);
    if (
      !intent
      || intent.resourceType !== IntentResourceType.CertificateRotation
    ) {
      throw new NotFoundException('Certificate rotation not found');
    }
    const certificate = await this.database
      .selectFrom('system.incus_client_certificates')
      .selectAll()
      .where('generation', '=', String(intent.targetGeneration))
      .executeTakeFirst()
      ?? await this.database
        .selectFrom('system.incus_client_certificates')
        .selectAll()
        .where('state', '=', CertificateState.Active)
        .executeTakeFirst();
    if (!certificate) {
      throw new NotFoundException('Incus client certificate is not configured');
    }
    return {
      rotationId: intent.id,
      generation: intent.targetGeneration,
      status: intent.status === IntentStatus.Succeeded
        ? CertificateRotationStatus.Succeeded
        : intent.status === IntentStatus.Failed
          ? CertificateRotationStatus.Failed
          : CertificateRotationStatus.Pending,
      certificate: await this.toDto(certificate, this.database),
      failureCode: intent.failureCode,
    };
  }

  private keyEncryptionSecret(): string {
    return this.config.keyEncryptionSecret();
  }

  private async toDto(
    certificate: CertificateRow,
    executor: Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>,
  ): Promise<IncusClientCertificateDto> {
    const trusts = await executor
      .selectFrom('system.incus_client_certificate_trusts')
      .selectAll()
      .where('certificate_id', '=', certificate.id)
      .execute();
    const trustByServer = new Map(trusts.map((trust) => [trust.server_id, trust]));
    const servers = await executor
      .selectFrom('infra.servers')
      .select('id')
      .orderBy('id')
      .execute();
    return {
      generation: numberValue(certificate.generation),
      fingerprint: certificate.fingerprint,
      notBefore: new Date(certificate.not_before).toISOString(),
      notAfter: new Date(certificate.not_after).toISOString(),
      state: certificate.state as CertificateState,
      servers: servers.map((server) => this.trustDto(
        server.id,
        trustByServer.get(server.id),
      )),
    };
  }

  private trustDto(serverId: string, trust: TrustRow | undefined) {
    return {
      serverId,
      trustState: (trust?.state ?? CertificateTrustState.Pending) as CertificateTrustState,
      observedAt: trust?.observed_at
        ? new Date(trust.observed_at).toISOString()
        : null,
      lastError: trust?.last_error ?? null,
    };
  }
}
