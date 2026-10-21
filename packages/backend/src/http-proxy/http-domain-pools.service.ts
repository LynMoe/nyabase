import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Kysely } from 'kysely';
import { assertListScope, type Actor } from '../iam/actor.js';
import {
  AuditAction,
  Capability,
  MAX_HTTP_PROXY_DOMAIN_POOLS,
  zCreateHttpDomainPoolRequest,
  zPatchHttpDomainPoolRequest,
  type HttpDomainPoolDto,
  type HttpDomainPoolPublicDto,
  type ListScope,
} from '@nyabase/common';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import { AuditService } from '../iam/audit.service.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { certificateFields, validateCertificate } from './http-proxy-certificates.js';
import {
  DOMAIN_POOL_MUTATION_LOCK,
  duplicateDomainPoolConflict,
  isUniqueConstraintViolation,
  lockHttpProxy,
  parseHttpProxyWildcardDomain,
  runSerializable,
  type DomainPoolRow,
  type HttpExecutor,
} from './http-proxy-support.js';

/** Wildcard domain pools: which hostnames bindings may use, and their TLS certificates. */
@Injectable()
export class HttpDomainPoolsService {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly config: NyabaseConfigService,
    private readonly accessResolver: AccessResolverService,
    private readonly audit: AuditService,
  ) {}

  /**
   * `scope=mine`: the enabled pools bindings may use (no certificate material).
   * `scope=all`: every pool, including disabled ones (`ManageSystemSettings`).
   */
  async listPools(actor: Actor, scope: ListScope): Promise<HttpDomainPoolDto[] | HttpDomainPoolPublicDto[]> {
    assertListScope(actor, scope, Capability.ManageSystemSettings);
    return scope === 'all' ? this.listDomainPools() : this.listEnabledDomainPools();
  }

  private async listDomainPools(): Promise<HttpDomainPoolDto[]> {
    const rows = await this.database
      .selectFrom('interaction.http_domain_pools')
      .selectAll()
      .orderBy('wildcard_domain')
      .execute();
    return rows.map((row) => this.domainPoolDto(row));
  }

  private async listEnabledDomainPools(): Promise<HttpDomainPoolPublicDto[]> {
    // User-facing catalog for binding UI: enabled pools only, never certificate PEMs.
    const rows = await this.database
      .selectFrom('interaction.http_domain_pools')
      .select(['id', 'wildcard_domain', 'https_enabled'])
      .where('enabled', '=', true)
      .orderBy('wildcard_domain')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      wildcardDomain: row.wildcard_domain,
      httpsEnabled: row.https_enabled,
    }));
  }

  async createDomainPool(
    actorId: string,
    input: unknown,
  ): Promise<HttpDomainPoolDto> {
    const dto = zCreateHttpDomainPoolRequest.parse(input);
    const wildcardDomain = parseHttpProxyWildcardDomain(dto.wildcardDomain);
    const certificate = certificateFields(
      dto.certificatePem,
      dto.privateKeyPem,
      wildcardDomain,
      this.config.keyEncryptionSecret(),
    );
    if (dto.httpsEnabled && !certificate.certificate_pem) {
      throw new BadRequestException('HTTPS requires a valid certificate and private key');
    }
    try {
      const row = await runSerializable(this.transactions, async (transaction) => {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageSystemSettings],
        );
        await lockHttpProxy(transaction, DOMAIN_POOL_MUTATION_LOCK);
        const existing = await transaction
          .selectFrom('interaction.http_domain_pools')
          .select('id')
          .where('wildcard_domain', '=', wildcardDomain)
          .executeTakeFirst();
        if (existing) throw duplicateDomainPoolConflict();
        const count = await this.domainPoolCount(transaction);
        if (count >= MAX_HTTP_PROXY_DOMAIN_POOLS) {
          throw new ConflictException({
            code: 'HTTP_PROXY_DOMAIN_POOL_CAPACITY_REACHED',
            message: `At most ${MAX_HTTP_PROXY_DOMAIN_POOLS} HTTP domain pools are supported`,
          });
        }
        const row = await transaction
          .insertInto('interaction.http_domain_pools')
          .values({
            id: randomUUID(),
            wildcard_domain: wildcardDomain,
            enabled: dto.enabled ?? true,
            https_enabled: dto.httpsEnabled ?? false,
            ...certificate,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.CreateHttpDomainPool,
          row.id,
          'http_domain_pool',
          this.domainPoolAuditDetails(row),
        );
        return row;
      });
      return this.domainPoolDto(row);
    } catch (error) {
      if (isUniqueConstraintViolation(error)) throw duplicateDomainPoolConflict();
      throw error;
    }
  }

  async updateDomainPool(
    actorId: string,
    id: string,
    input: unknown,
  ): Promise<HttpDomainPoolDto> {
    const dto = zPatchHttpDomainPoolRequest.parse(input);
    try {
      const row = await runSerializable(this.transactions, async (transaction) => {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageSystemSettings],
        );
        await lockHttpProxy(transaction, DOMAIN_POOL_MUTATION_LOCK);
        const current = await transaction
          .selectFrom('interaction.http_domain_pools')
          .selectAll()
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (!current) throw new NotFoundException('Domain pool not found');

        let wildcardDomain = current.wildcard_domain;
        if (dto.wildcardDomain !== undefined) {
          const nextWildcard = parseHttpProxyWildcardDomain(dto.wildcardDomain);
          if (nextWildcard !== current.wildcard_domain) {
            const owner = await transaction
              .selectFrom('interaction.http_domain_pools')
              .select('id')
              .where('wildcard_domain', '=', nextWildcard)
              .executeTakeFirst();
            if (owner && owner.id !== current.id) throw duplicateDomainPoolConflict();
            const binding = await transaction
              .selectFrom('interaction.http_proxy_bindings')
              .select('id')
              .where('domain_pool_id', '=', id)
              .limit(1)
              .executeTakeFirst();
            if (binding) {
              throw new ConflictException(
                'Domain pool wildcard cannot change while bindings exist',
              );
            }
            wildcardDomain = nextWildcard;
          }
        }

        let certificate = {
          certificate_pem: current.certificate_pem,
          encrypted_private_key_pem: current.encrypted_private_key_pem,
          certificate_fingerprint: current.certificate_fingerprint,
          certificate_not_after: current.certificate_not_after,
        };
        if (dto.certificatePem !== undefined || dto.privateKeyPem !== undefined) {
          if (dto.certificatePem === undefined || dto.privateKeyPem === undefined) {
            throw new BadRequestException(
              'certificatePem and privateKeyPem must be updated together',
            );
          }
          certificate = certificateFields(
            dto.certificatePem,
            dto.privateKeyPem,
            wildcardDomain,
            this.config.keyEncryptionSecret(),
          );
        } else if (current.certificate_pem) {
          validateCertificate(current.certificate_pem, wildcardDomain);
        }
        const httpsEnabled = dto.httpsEnabled ?? current.https_enabled;
        if (
          httpsEnabled
          && (!certificate.certificate_pem || !certificate.encrypted_private_key_pem)
        ) {
          throw new BadRequestException('HTTPS requires a valid certificate and private key');
        }
        const row = await transaction
          .updateTable('interaction.http_domain_pools')
          .set({
            wildcard_domain: wildcardDomain,
            enabled: dto.enabled ?? current.enabled,
            https_enabled: httpsEnabled,
            ...certificate,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.UpdateHttpDomainPool,
          row.id,
          'http_domain_pool',
          this.domainPoolAuditDetails(row),
        );
        return row;
      });
      return this.domainPoolDto(row);
    } catch (error) {
      if (isUniqueConstraintViolation(error)) throw duplicateDomainPoolConflict();
      throw error;
    }
  }

  async deleteDomainPool(actorId: string, id: string): Promise<void> {
    await runSerializable(this.transactions, async (transaction) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageSystemSettings],
      );
      await lockHttpProxy(transaction, DOMAIN_POOL_MUTATION_LOCK);
      const row = await transaction
        .selectFrom('interaction.http_domain_pools')
        .select('id')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new NotFoundException('Domain pool not found');
      const binding = await transaction
        .selectFrom('interaction.http_proxy_bindings')
        .select('id')
        .where('domain_pool_id', '=', id)
        .limit(1)
        .executeTakeFirst();
      if (binding) throw new ConflictException('Domain pool still has bindings');
      await transaction
        .deleteFrom('interaction.http_domain_pools')
        .where('id', '=', id)
        .execute();
      await this.audit.append(
        transaction,
        actorId,
        AuditAction.DeleteHttpDomainPool,
        id,
        'http_domain_pool',
      );
    });
  }

  private domainPoolDto(row: DomainPoolRow): HttpDomainPoolDto {
    return {
      id: row.id,
      wildcardDomain: row.wildcard_domain,
      enabled: row.enabled,
      httpsEnabled: row.https_enabled,
      certificateFingerprint: row.certificate_fingerprint,
      certificateNotAfter: row.certificate_not_after?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private domainPoolAuditDetails(row: DomainPoolRow) {
    return {
      wildcardDomain: row.wildcard_domain,
      enabled: row.enabled,
      httpsEnabled: row.https_enabled,
      certificateFingerprint: row.certificate_fingerprint,
    };
  }

  private async domainPoolCount(executor: HttpExecutor): Promise<number> {
    const row = await executor
      .selectFrom('interaction.http_domain_pools')
      .select((expression) => expression.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
}
