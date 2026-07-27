import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import {
  AuditAction,
  Capability,
  zResourceIdentity,
  type AuditListResponse,
  type AuditLogDto,
  type AuditResourceSnapshotDto,
} from '@nyabase/common';
import {
  AuditRepository,
  MAX_AUDIT_OFFSET,
  type AuditEvent,
  type AuditListFilter,
} from './audit.repository.js';

@Controller('audit')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ViewAudit)
export class AuditController {
  constructor(private readonly repository: AuditRepository) {}

  @Get()
  async list(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
  ): Promise<AuditListResponse | AuditLogDto[]> {
    const parsedLimit = parseLimit(limit);
    const parsedOffset = parseOffset(offset);
    const filter = parseFilter({ action, actorId, targetType, targetId });
    const page = await this.repository.list(
      parsedLimit,
      parsedOffset,
      filter,
    );

    if (offset === undefined) {
      return page.items.map(toDto);
    }

    return {
      items: page.items.map(toDto),
      total: page.total,
      limit: parsedLimit,
      offset: parsedOffset,
    };
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<AuditLogDto> {
    const auditId = zResourceIdentity.parse(id);
    const row = await this.repository.findById(auditId);
    if (!row) throw new NotFoundException('Audit log not found');
    return toDto(row);
  }
}

function toDto(row: AuditEvent): AuditLogDto {
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

function parseFilter(input: {
  action?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
}): AuditListFilter {
  const filter: AuditListFilter = {};
  if (input.action !== undefined) {
    if (!(Object.values(AuditAction) as string[]).includes(input.action)) {
      throw invalidFilter('action is not a known audit action');
    }
    filter.action = input.action;
  }
  if (input.actorId !== undefined) {
    filter.actorId = parseResourceFilter(input.actorId, 'actorId');
  }
  if (input.targetId !== undefined) {
    filter.targetId = parseResourceFilter(input.targetId, 'targetId');
  }
  if (input.targetType !== undefined) {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(input.targetType)) {
      throw invalidFilter('targetType is invalid');
    }
    filter.targetType = input.targetType;
  }
  return filter;
}

function parseResourceFilter(value: string, field: string): string {
  const parsed = zResourceIdentity.safeParse(value);
  if (!parsed.success) throw invalidFilter(`${field} is invalid`);
  return parsed.data;
}

function invalidFilter(message: string): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_AUDIT_FILTER',
    message,
  });
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 100;
  const parsed = parsePaginationInteger(value, 'limit');
  if (parsed < 1) throw invalidPagination('limit must be at least 1');
  return Math.min(Math.max(parsed, 1), 500);
}

function parseOffset(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = parsePaginationInteger(value, 'offset');
  if (parsed > MAX_AUDIT_OFFSET) {
    throw invalidPagination(`offset must not exceed ${MAX_AUDIT_OFFSET}`);
  }
  return parsed;
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
