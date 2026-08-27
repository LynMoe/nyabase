import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AuditAction,
  FailureCode,
  canonicalIpv4Cidr,
  ipv4CidrContains,
  ipv4CidrsOverlap,
  isUsableHostInCidr,
  parseCidr,
  type CreateIpPoolRequest,
  type IpPoolDto,
  type PatchIpPoolRequest,
} from '@nyabase/common';
import type { Kysely } from 'kysely';
import { IpPoolsRepository, type IpPoolRow } from './ip-pools.repository.js';
import { isoDate, numberValue } from '../domain/domain-utils.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { AuditService } from '../audit/audit.service.js';

function stringArray(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function usableHostCount(cidr: string): number {
  const { prefixLen } = parseCidr(cidr);
  const hostBits = 32 - prefixLen;
  if (hostBits <= 1) return 0;
  return 2 ** hostBits - 2;
}

function blockedInsideAllocation(
  allocationCidr: string,
  gateway: string,
  reservedIps: readonly string[],
): number {
  let blocked = 0;
  if (isUsableHostInCidr(allocationCidr, gateway)) blocked += 1;
  const seen = new Set<string>();
  for (const address of reservedIps) {
    if (seen.has(address)) continue;
    seen.add(address);
    if (isUsableHostInCidr(allocationCidr, address) && address !== gateway) {
      blocked += 1;
    }
  }
  return blocked;
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (record.code === '23505') return true;
    current = record.cause;
  }
  return false;
}

@Injectable()
export class IpPoolsService {
  constructor(
    private readonly repository: IpPoolsRepository,
    private readonly transactions: PgTransactionManager,
    private readonly audit: AuditService,
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  async list(): Promise<IpPoolDto[]> {
    const rows = await this.repository.list();
    return Promise.all(rows.map((row) => this.toDto(row)));
  }

  async get(id: string): Promise<IpPoolDto> {
    const row = await this.repository.findById(id);
    if (!row) throw new NotFoundException('IP pool not found');
    return this.toDto(row);
  }

  async create(actorId: string, input: CreateIpPoolRequest): Promise<IpPoolDto> {
    const cidr = canonicalIpv4Cidr(input.cidr);
    const allocationCidr = canonicalIpv4Cidr(input.allocationCidr);
    if (!ipv4CidrContains(cidr, allocationCidr)) {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'allocationCidr must be entirely contained in cidr',
      });
    }
    try {
      const row = await this.transactions.run(async (transaction) => {
        await this.assertNoCidrOverlap(cidr, undefined, transaction);
        await this.assertServersExist(input.serverIds, transaction);
        const created = await this.repository.insert({
          id: randomUUID(),
          name: input.name.trim(),
          cidr,
          allocationCidr,
          gateway: input.gateway,
          reservedIps: input.reservedIps,
        }, transaction);
        await this.repository.replaceServers(created.id, input.serverIds, transaction);
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.CreateIpPool,
          created.id,
          'ip_pool',
          {
            name: created.name,
            cidr: created.cidr,
            allocationCidr: created.allocation_cidr,
            serverIds: input.serverIds,
          },
        );
        return created;
      });
      return this.get(row.id);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: FailureCode.IpPoolCidrConflict,
          message: 'IP pool name or CIDR already exists',
        });
      }
      throw error;
    }
  }

  async patch(actorId: string, id: string, input: PatchIpPoolRequest): Promise<IpPoolDto> {
    try {
      await this.transactions.run(async (transaction) => {
        const current = await this.repository.findByIdForUpdate(id, transaction);
        if (!current) throw new NotFoundException('IP pool not found');
        if (Number(current.revision) !== input.expectedRevision) {
          throw new ConflictException({ code: FailureCode.RevisionConflict });
        }

        const nextCidr = input.cidr === undefined
          ? current.cidr
          : canonicalIpv4Cidr(input.cidr);
        const nextAllocationCidr = input.allocationCidr === undefined
          ? current.allocation_cidr
          : canonicalIpv4Cidr(input.allocationCidr);
        const nextGateway = input.gateway ?? current.gateway;
        const nextReserved = input.reservedIps ?? stringArray(current.reserved_ips);

        if (
          input.cidr !== undefined
          || input.allocationCidr !== undefined
          || input.gateway !== undefined
          || input.reservedIps !== undefined
        ) {
          if (!isUsableHostInCidr(nextCidr, nextGateway)) {
            throw new BadRequestException({
              code: FailureCode.InvalidInput,
              message: 'gateway must be a usable host inside cidr',
            });
          }
          if (!ipv4CidrContains(nextCidr, nextAllocationCidr)) {
            throw new BadRequestException({
              code: FailureCode.InvalidInput,
              message: 'allocationCidr must be entirely contained in cidr',
            });
          }
          for (const address of nextReserved) {
            if (!isUsableHostInCidr(nextCidr, address)) {
              throw new BadRequestException({
                code: FailureCode.InvalidInput,
                message: 'reservedIps must contain usable hosts inside cidr',
              });
            }
          }
          if (input.cidr !== undefined && nextCidr !== current.cidr) {
            const claimCount = await this.repository.countClaimsForNetwork(current.cidr, transaction);
            if (claimCount > 0) {
              throw new ConflictException({
                code: FailureCode.IpPoolInUse,
                message: 'Cannot change CIDR while addresses are claimed',
                details: { poolId: id, claimCount },
              });
            }
            await this.assertNoCidrOverlap(nextCidr, id, transaction);
          }
          if (
            input.allocationCidr !== undefined
            && nextAllocationCidr !== current.allocation_cidr
          ) {
            const claimed = await this.repository.listClaimAddresses(current.cidr, transaction);
            const outside = claimed.filter((address) => !isUsableHostInCidr(nextAllocationCidr, address));
            if (outside.length > 0) {
              throw new ConflictException({
                code: FailureCode.IpPoolInUse,
                message: 'Cannot shrink allocationCidr while claimed addresses fall outside it',
                details: { poolId: id, addresses: outside.slice(0, 16) },
              });
            }
          }
        }

        if (input.serverIds !== undefined) {
          await this.assertServersExist(input.serverIds, transaction);
          const existing = await this.repository.listServerIds(id, transaction);
          const next = new Set(input.serverIds);
          const removed = existing.filter((serverId) => !next.has(serverId));
          for (const serverId of removed) {
            const claimCount = await this.repository.countClaimsForNetwork(
              current.cidr,
              transaction,
              { serverId },
            );
            if (claimCount > 0) {
              throw new ConflictException({
                code: FailureCode.IpPoolInUse,
                message: 'Cannot unbind a server while it still has claimed addresses in this pool',
                details: { poolId: id, serverId, claimCount },
              });
            }
          }
          await this.repository.replaceServers(id, input.serverIds, transaction);
        }

        const updated = await this.repository.update(id, input.expectedRevision, {
          ...(input.name === undefined ? {} : { name: input.name.trim() }),
          ...(input.cidr === undefined ? {} : { cidr: nextCidr }),
          ...(input.allocationCidr === undefined
            ? {}
            : { allocationCidr: nextAllocationCidr }),
          ...(input.gateway === undefined ? {} : { gateway: nextGateway }),
          ...(input.reservedIps === undefined ? {} : { reservedIps: nextReserved }),
        }, transaction);
        if (!updated) {
          throw new ConflictException({ code: FailureCode.RevisionConflict });
        }
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.UpdateIpPool,
          id,
          'ip_pool',
          {
            name: input.name,
            cidr: input.cidr,
            allocationCidr: input.allocationCidr,
            gateway: input.gateway,
            reservedIps: input.reservedIps,
            serverIds: input.serverIds,
          },
        );
      });
      return this.get(id);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: FailureCode.IpPoolCidrConflict,
          message: 'IP pool name or CIDR already exists',
        });
      }
      throw error;
    }
  }

  async delete(actorId: string, id: string): Promise<void> {
    await this.transactions.run(async (transaction) => {
      const current = await this.repository.findByIdForUpdate(id, transaction);
      if (!current) throw new NotFoundException('IP pool not found');
      const claimCount = await this.repository.countClaimsForNetwork(current.cidr, transaction);
      if (claimCount > 0) {
        throw new ConflictException({
          code: FailureCode.IpPoolInUse,
          message: 'Cannot delete an IP pool while addresses are claimed',
          details: { poolId: id, claimCount },
        });
      }
      await this.repository.delete(id, transaction);
      await this.audit.append(
        transaction,
        actorId,
        AuditAction.DeleteIpPool,
        id,
        'ip_pool',
        { name: current.name, cidr: current.cidr, allocationCidr: current.allocation_cidr },
      );
    });
  }

  private async assertNoCidrOverlap(
    cidr: string,
    excludeId: string | undefined,
    executor: Parameters<IpPoolsRepository['listAllCidrs']>[0],
  ): Promise<void> {
    const existing = await this.repository.listAllCidrs(executor, excludeId);
    for (const row of existing) {
      if (ipv4CidrsOverlap(cidr, row.cidr)) {
        throw new ConflictException({
          code: FailureCode.IpPoolCidrConflict,
          message: 'IP pool CIDR overlaps an existing pool',
          details: { cidr, conflictingPoolId: row.id, conflictingCidr: row.cidr },
        });
      }
    }
  }

  private async assertServersExist(
    serverIds: readonly string[],
    executor: typeof this.database,
  ): Promise<void> {
    if (serverIds.length === 0) return;
    const rows = await executor
      .selectFrom('infra.servers')
      .select('id')
      .where('id', 'in', [...serverIds])
      .execute();
    if (rows.length !== serverIds.length) {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'One or more serverIds do not exist',
      });
    }
  }

  private async toDto(row: IpPoolRow): Promise<IpPoolDto> {
    const reservedIps = stringArray(row.reserved_ips);
    const allocatedCount = await this.repository.countAllocated(row.cidr);
    const blocked = blockedInsideAllocation(row.allocation_cidr, row.gateway, reservedIps);
    const usable = Math.max(0, usableHostCount(row.allocation_cidr) - blocked);
    return {
      id: row.id,
      name: row.name,
      cidr: row.cidr,
      allocationCidr: row.allocation_cidr,
      gateway: row.gateway,
      reservedIps,
      serverIds: row.server_ids ?? [],
      allocatedCount,
      usableCount: usable,
      revision: numberValue(row.revision),
      createdAt: isoDate(row.created_at) ?? new Date(0).toISOString(),
      updatedAt: isoDate(row.updated_at) ?? new Date(0).toISOString(),
    };
  }
}
