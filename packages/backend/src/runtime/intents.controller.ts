import {
  Controller,
  Body,
  ConflictException,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  Capability,
  IntentResourceType,
  IntentStatus,
  zIntentListQuery,
  zRetryIntentRequest,
  type IntentDto,
} from '@nyabase/common';
import type { Kysely } from 'kysely';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireAnyCaps, RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import {
  IntentRepository,
  type IntentListOptions,
  type IntentRecord,
} from './intent.repository.js';

function adminCapabilityForIntent(
  resourceType: IntentRecord['resourceType'],
  sharedVolume = false,
): Capability | null {
  switch (resourceType) {
    case IntentResourceType.Container:
      return Capability.ManageContainersAny;
    case IntentResourceType.Volume:
      return sharedVolume ? Capability.ManageSharedVolumes : Capability.ManageVolumes;
    case IntentResourceType.Server:
      return Capability.ManageServers;
    case IntentResourceType.ImageAssignment:
      return Capability.ManageImages;
    case IntentResourceType.CertificateRotation:
      return Capability.ManageCertificates;
    default:
      return null;
  }
}

function toDto(intent: IntentRecord): IntentDto {
  return {
    id: intent.id,
    kind: intent.kind as IntentDto['kind'],
    resourceType: intent.resourceType as IntentDto['resourceType'],
    resourceId: intent.resourceId,
    serverId: intent.serverId,
    requestedBy: intent.requestedBy,
    requestSummary: intent.request ?? {},
    targetGeneration: intent.targetGeneration,
    baseline: intent.baseline,
    status: intent.status as IntentDto['status'],
    failureCode: intent.failureCode,
    failure: intent.failure
      ? {
        code: intent.failure.code,
        message: intent.failure.message,
        details: intent.failure.details ?? {},
      }
      : null,
    attemptCount: intent.attemptCount,
    nextAttemptAt: intent.nextAttemptAt,
    createdAt: intent.createdAt,
    settledAt: intent.settledAt,
    blockedByIntentId: intent.blockedByIntentId ?? null,
  };
}

function listOptions(query: Record<string, unknown>): IntentListOptions {
  const parsed = zIntentListQuery.parse(query);
  return {
    limit: parsed.limit,
    cursor: parsed.cursor,
    status: parsed.status as IntentListOptions['status'],
    kind: parsed.kind as IntentListOptions['kind'],
  };
}

@Controller('containers/:containerId/intents')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class ContainerIntentsController {
  constructor(
    private readonly intents: IntentRepository,
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  @Get()
  async list(
    @Param('containerId') containerId: string,
    @CurrentUser() user: UserRecord,
    @Query() query: Record<string, unknown>,
  ) {
    const container = await this.database
      .selectFrom('control.containers')
      .select(['owner_id'])
      .where('id', '=', containerId)
      .executeTakeFirst();
    if (!container || container.owner_id !== user.id) {
      throw new NotFoundException('Container not found');
    }
    const page = await this.intents.list({
      ...listOptions(query),
      resourceId: containerId,
      resourceType: 'container',
    });
    return {
      items: page.items.map(toDto),
      nextCursor: page.nextCursor,
    };
  }
}

@Controller('admin/containers/:containerId/intents')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageContainersAny)
export class AdminContainerIntentsController {
  constructor(private readonly intents: IntentRepository) {}

  @Get()
  async list(
    @Param('containerId') containerId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const page = await this.intents.list({
      ...listOptions(query),
      resourceId: containerId,
      resourceType: 'container',
    });
    return {
      items: page.items.map(toDto),
      nextCursor: page.nextCursor,
    };
  }
}

@Controller('volumes/:volumeId/intents')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class VolumeIntentsController {
  constructor(
    private readonly intents: IntentRepository,
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  @Get()
  async list(
    @Param('volumeId') volumeId: string,
    @CurrentUser() user: UserRecord,
    @Query() query: Record<string, unknown>,
  ) {
    const volume = await this.database.selectFrom('control.volumes')
      .select(['owner_id', 'shared_backend_id']).where('id', '=', volumeId).executeTakeFirst();
    if (!volume || volume.owner_id !== user.id || volume.shared_backend_id !== null) {
      throw new NotFoundException('Volume not found');
    }
    const page = await this.intents.listForResource('volume', volumeId, listOptions(query));
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }
}

@Controller('shared-volumes/:volumeId/intents')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class SharedVolumeIntentsController {
  constructor(
    private readonly intents: IntentRepository,
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  @Get()
  async list(
    @Param('volumeId') volumeId: string,
    @CurrentUser() user: UserRecord,
    @Query() query: Record<string, unknown>,
  ) {
    const volume = await this.database.selectFrom('control.volumes')
      .select(['owner_id', 'shared_backend_id']).where('id', '=', volumeId).executeTakeFirst();
    if (!volume || volume.owner_id !== user.id || volume.shared_backend_id === null) {
      throw new NotFoundException('Volume not found');
    }
    const page = await this.intents.listForResource('volume', volumeId, listOptions(query));
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }
}

@Controller('admin/volumes/:volumeId/intents')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageVolumes)
export class AdminVolumeIntentsController {
  constructor(
    private readonly intents: IntentRepository,
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  @Get()
  async list(
    @Param('volumeId') volumeId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const volume = await this.database.selectFrom('control.volumes')
      .select('shared_backend_id').where('id', '=', volumeId).executeTakeFirst();
    if (!volume || volume.shared_backend_id !== null) {
      throw new NotFoundException('Volume not found');
    }
    const page = await this.intents.listForResource('volume', volumeId, listOptions(query));
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }
}

@Controller('admin/shared-volumes/:volumeId/intents')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageSharedVolumes)
export class AdminSharedVolumeIntentsController {
  constructor(
    private readonly intents: IntentRepository,
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  @Get()
  async list(
    @Param('volumeId') volumeId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const volume = await this.database.selectFrom('control.volumes')
      .select('shared_backend_id').where('id', '=', volumeId).executeTakeFirst();
    if (!volume || volume.shared_backend_id === null) {
      throw new NotFoundException('Volume not found');
    }
    const page = await this.intents.listForResource('volume', volumeId, listOptions(query));
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }
}

const ADMIN_INTENT_CAPABILITIES = [
  Capability.ManageContainersAny,
  Capability.ManageVolumes,
  Capability.ManageSharedVolumes,
  Capability.ManageServers,
  Capability.ManageImages,
  Capability.ManageCertificates,
] as const;

@Controller('admin/intents')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireAnyCaps(...ADMIN_INTENT_CAPABILITIES)
export class AdminIntentsController {
  constructor(
    private readonly intents: IntentRepository,
    private readonly access: AccessResolverService,
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  @Get()
  async list(@Query() query: Record<string, unknown>, @CurrentUser() user: UserRecord) {
    const allowedTypes = await this.allowedResourceTypes(user.id);
    if (allowedTypes.length === 0) {
      return { items: [], nextCursor: null };
    }
    const options = listOptions(query);
    if (options.resourceType && !allowedTypes.includes(options.resourceType)) {
      return { items: [], nextCursor: null };
    }
    const page = await this.intents.list({
      ...options,
      resourceTypes: options.resourceType ? undefined : allowedTypes,
    });
    const items = await this.filterVolumeIntents(user.id, page.items);
    return {
      items: items.map(toDto),
      nextCursor: page.nextCursor,
    };
  }

  @Get(':intentId')
  async get(@Param('intentId') intentId: string, @CurrentUser() user: UserRecord) {
    const intent = await this.intents.findById(intentId);
    if (!intent) throw new NotFoundException('Intent not found');
    await this.assertIntentCapability(user.id, intent);
    return toDto(intent);
  }

  @Post(':intentId/retry')
  async retry(
    @Param('intentId') intentId: string,
    @CurrentUser() user: UserRecord,
    @Body() body: unknown,
  ) {
    zRetryIntentRequest.parse(body);
    const intent = await this.intents.findById(intentId);
    if (!intent) throw new NotFoundException('Intent not found');
    const required = await this.capabilityFor(intent);
    if (!required) throw new NotFoundException('Intent not found');
    try {
      return await this.access.runWithActorCapabilities(
        user.id,
        [required],
        async (transaction) => {
          const current = await this.intents.findById(intentId, transaction);
          if (!current) throw new NotFoundException('Intent not found');
          const currentRequired = await this.capabilityFor(current);
          if (currentRequired !== required) {
            throw new NotFoundException('Intent not found');
          }
          if (current.status !== IntentStatus.Failed) {
            throw new ConflictException('Only failed intents can be retried');
          }
          return toDto(await this.intents.retry(intentId, transaction));
        },
      );
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw new NotFoundException('Intent not found');
      }
      throw error;
    }
  }

  private async allowedResourceTypes(
    actorId: string,
  ): Promise<IntentRecord['resourceType'][]> {
    const capabilities = await this.access.userCapabilitiesCurrent(actorId);
    const types = (Object.values(IntentResourceType) as IntentRecord['resourceType'][])
      .filter((type) => {
        if (type === IntentResourceType.Volume) {
          return capabilities.has(Capability.ManageVolumes)
            || capabilities.has(Capability.ManageSharedVolumes);
        }
        const capability = adminCapabilityForIntent(type);
        return capability != null && capabilities.has(capability);
      });
    return types;
  }

  private async assertIntentCapability(
    actorId: string,
    intent: IntentRecord,
  ): Promise<void> {
    const required = await this.capabilityFor(intent);
    if (!required) throw new NotFoundException('Intent not found');
    const capabilities = await this.access.userCapabilitiesCurrent(actorId);
    if (!capabilities.has(required)) {
      throw new NotFoundException('Intent not found');
    }
  }

  private async capabilityFor(intent: IntentRecord): Promise<Capability | null> {
    if (intent.resourceType !== IntentResourceType.Volume) {
      return adminCapabilityForIntent(intent.resourceType);
    }
    const volume = await this.database.selectFrom('control.volumes')
      .select('shared_backend_id')
      .where('id', '=', intent.resourceId)
      .executeTakeFirst();
    return adminCapabilityForIntent(intent.resourceType, volume?.shared_backend_id != null);
  }

  private async filterVolumeIntents(
    actorId: string,
    items: readonly IntentRecord[],
  ): Promise<IntentRecord[]> {
    const volumeIds = items
      .filter((item) => item.resourceType === IntentResourceType.Volume)
      .map((item) => item.resourceId);
    if (volumeIds.length === 0) return [...items];
    const capabilities = await this.access.userCapabilitiesCurrent(actorId);
    const volumes = await this.database.selectFrom('control.volumes')
      .select(['id', 'shared_backend_id'])
      .where('id', 'in', volumeIds)
      .execute();
    const shared = new Set(
      volumes.filter((row) => row.shared_backend_id !== null).map((row) => row.id),
    );
    return items.filter((item) => {
      if (item.resourceType !== IntentResourceType.Volume) return true;
      const required = shared.has(item.resourceId)
        ? Capability.ManageSharedVolumes
        : Capability.ManageVolumes;
      return capabilities.has(required);
    });
  }
}

@Controller('admin/servers/:serverId/intents')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageServers)
export class AdminServerIntentsController {
  constructor(private readonly intents: IntentRepository) {}

  @Get()
  async list(
    @Param('serverId') serverId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const parsed = listOptions(query);
    const page = await this.intents.list({ ...parsed, serverId });
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }
}

@Controller('admin/images/:imageId/assignments/:serverId/intents')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageImages)
export class AdminImageAssignmentIntentsController {
  constructor(
    private readonly intents: IntentRepository,
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  @Get()
  async list(
    @Param('imageId') imageId: string,
    @Param('serverId') serverId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const assignment = await this.database.selectFrom('infra.image_server_assignments')
      .select('id')
      .where('image_id', '=', imageId)
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!assignment) throw new NotFoundException('Image assignment not found');
    const page = await this.intents.listForResource(
      'image_assignment',
      assignment.id,
      listOptions(query),
    );
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }
}

@Controller('admin/images/:imageId/intents')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageImages)
export class AdminImageIntentsController {
  constructor(
    private readonly intents: IntentRepository,
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  @Get()
  async list(
    @Param('imageId') imageId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const options = listOptions(query);
    const assignments = await this.database.selectFrom('infra.image_server_assignments')
      .select('id')
      .where('image_id', '=', imageId)
      .execute();
    const page = await this.intents.list({
      ...options,
      resourceType: 'image_assignment',
      resourceIds: assignments.map((assignment) => assignment.id),
    });
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }
}

@Controller('intents')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class IntentsController {
  constructor(
    private readonly intents: IntentRepository,
    private readonly access: AccessResolverService,
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  @Get(':intentId')
  async get(@Param('intentId') intentId: string, @CurrentUser() user: UserRecord) {
    const intent = await this.intents.findById(intentId);
    if (!intent) throw new NotFoundException('Intent not found');
    await this.assertIntentReadable(intent, user);
    return toDto(intent);
  }

  @Post(':intentId/retry')
  async retry(
    @Param('intentId') intentId: string,
    @CurrentUser() user: UserRecord,
    @Body() body: unknown,
  ) {
    zRetryIntentRequest.parse(body);
    const intent = await this.intents.findById(intentId);
    if (!intent) {
      throw new NotFoundException('Intent not found');
    }
    await this.assertIntentReadable(intent, user);
    if (intent.status !== IntentStatus.Failed) {
      throw new ConflictException('Only failed intents can be retried');
    }
    return toDto(await this.intents.retry(intentId));
  }

  private async assertIntentReadable(intent: IntentRecord, user: UserRecord): Promise<void> {
    if (intent.requestedBy === user.id) {
      return;
    }

    const adminCapability = adminCapabilityForIntent(intent.resourceType);
    if (adminCapability && await this.access.hasCapability(user.id, adminCapability)) {
      return;
    }

    if (
      intent.resourceType === IntentResourceType.Container
      || intent.resourceType === IntentResourceType.Volume
    ) {
      const table = intent.resourceType === IntentResourceType.Container
        ? 'control.containers'
        : 'control.volumes';
      const row = await this.database.selectFrom(table)
        .select('owner_id')
        .where('id', '=', intent.resourceId)
        .executeTakeFirst();
      if (row?.owner_id === user.id) {
        return;
      }
    }

    throw new ForbiddenException('Intent is not owned by current user');
  }
}
