import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { AuditLogEntity } from '../entities/audit-log.entity.js';
import {
  Capability,
  zResourceIdentity,
  type AuditListResponse,
  type AuditLogDto,
  type AuditResourceSnapshotDto,
} from '@nyabase/common';

@Controller('audit')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ViewAudit)
export class AuditController {
  constructor(
    @InjectRepository(AuditLogEntity)
    private repo: Repository<AuditLogEntity>,
  ) {}

  @Get()
  async list(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<AuditListResponse | AuditLogDto[]> {
    const parsedLimit = parseLimit(limit);
    const parsedOffset = parseOffset(offset);

    if (offset === undefined) {
      const items = await this.repo.find({
        order: { ts: 'DESC' },
        take: parsedLimit,
      });
      return items.map(toDto);
    }

    const [items, total] = await this.repo.findAndCount({
      order: { ts: 'DESC' },
      take: parsedLimit,
      skip: parsedOffset,
    });
    return {
      items: items.map(toDto),
      total,
      limit: parsedLimit,
      offset: parsedOffset,
    };
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<AuditLogDto> {
    const auditId = zResourceIdentity.parse(id);
    const row = await this.repo.findOne({ where: { id: auditId } });
    if (!row) throw new NotFoundException('Audit log not found');
    return toDto(row);
  }
}

function toDto(row: AuditLogEntity): AuditLogDto {
  return {
    id: row.id,
    actorId: row.actorId,
    actorName: row.actorName ?? null,
    actorUsername: row.actorUsername ?? null,
    actorSnapshot: snapshot(row.actorSnapshot),
    action: row.action,
    targetId: row.targetId,
    targetType: row.targetType,
    targetName: row.targetName ?? null,
    targetSnapshot: snapshot(row.targetSnapshot),
    related: snapshots(row.related),
    payload: row.payload ?? null,
    ts: row.ts.toISOString(),
  };
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 100;
  const parsed = parsePaginationInteger(value, 'limit');
  if (parsed < 1) throw invalidPagination('limit must be at least 1');
  return Math.min(Math.max(parsed, 1), 500);
}

function parseOffset(value: string | undefined): number {
  if (value === undefined) return 0;
  return parsePaginationInteger(value, 'offset');
}

function parsePaginationInteger(value: string, field: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw invalidPagination(`${field} must be a canonical non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidPagination(`${field} exceeds the safe integer range`);
  }
  return parsed;
}

function invalidPagination(message: string): BadRequestException {
  return new BadRequestException({ code: 'INVALID_AUDIT_PAGINATION', message });
}

function snapshots(value: unknown): AuditResourceSnapshotDto[] {
  return Array.isArray(value)
    ? value.map(snapshot).filter((entry): entry is AuditResourceSnapshotDto => entry !== null)
    : [];
}

function snapshot(value: unknown): AuditResourceSnapshotDto | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    id: typeof record.id === 'string' ? record.id : null,
    type: typeof record.type === 'string' ? record.type : null,
    name: typeof record.name === 'string' ? record.name : null,
    labels: labels(record.labels),
  };
}

function labels(value: unknown): Record<string, string | number | boolean | null> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean' ||
      entry === null
    ) {
      output[key] = entry;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}
