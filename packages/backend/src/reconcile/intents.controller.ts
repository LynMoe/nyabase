import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ADMIN_INTENT_CAPABILITIES,
  Capability,
  IntentResourceType,
  IntentStatus,
  zIntentListQuery,
  zRetryIntentRequest,
} from '@nyabase/common';
import { CurrentActor } from '../iam/decorators/current-actor.decorator.js';
import { holdsAny, type Actor } from '../iam/actor.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import { toDto } from './intent-dto.js';
import { IntentRepository, type IntentListOptions, type IntentRecord } from './intent.repository.js';
import { ReconcilerRegistry } from './reconciler-registry.service.js';

/**
 * The capability that governs a resource type regardless of which row it is.
 * Volumes are the only type whose governing capability depends on the row
 * (shared volumes use `ManageSharedVolumes`); `resourceAuthorities` answers
 * that precisely.
 */
function typeCapability(resourceType: IntentRecord['resourceType']): Capability | null {
  switch (resourceType) {
    case IntentResourceType.Container:
      return Capability.ManageContainersAny;
    case IntentResourceType.Volume:
      return Capability.ManageVolumes;
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

const DEFAULT_PAGE_SIZE = 50;

/**
 * The only intents surface. Visibility of an intent:
 *  - it is yours: you requested it, or you own its resource; or
 *  - you hold the capability that governs its resource type.
 * `GET /intents?scope=mine` (default) lists the former, `scope=all` the latter.
 */
@Controller('intents')
export class IntentsController {
  constructor(
    private readonly intents: IntentRepository,
    private readonly access: AccessResolverService,
    private readonly registry: ReconcilerRegistry,
  ) {}

  @Get()
  async list(@CurrentActor() actor: Actor, @Query() query: Record<string, unknown>) {
    const parsed = zIntentListQuery.parse(query);
    const resourceIds = parsed.resourceId?.split(',').filter(Boolean);
    if (resourceIds && (!parsed.resourceType || resourceIds.length > MAX_RESOURCE_IDS)) {
      throw new BadRequestException('resourceId needs resourceType and at most 100 ids');
    }
    const base: IntentListOptions = {
      limit: parsed.limit ?? (parsed.scope === 'all' && !resourceIds ? 500 : DEFAULT_PAGE_SIZE),
      cursor: parsed.cursor,
      status: parsed.status as IntentListOptions['status'],
      kind: parsed.kind as IntentListOptions['kind'],
      serverId: parsed.serverId,
      resourceType: parsed.resourceType,
      ...(resourceIds ? { resourceIds } : {}),
    };
    const page = parsed.scope === 'all'
      ? await this.listAll(actor, base, resourceIds)
      : await this.listMine(actor, base, resourceIds);
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }

  @Get(':intentId')
  async get(@Param('intentId') intentId: string, @CurrentActor() actor: Actor) {
    const intent = await this.intents.findById(intentId);
    if (!intent) throw new NotFoundException('Intent not found');
    await this.assertVisible(actor, intent);
    return toDto(intent);
  }

  @Post(':intentId/retry')
  async retry(
    @Param('intentId') intentId: string,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ) {
    zRetryIntentRequest.parse(body);
    const intent = await this.intents.findById(intentId);
    if (!intent) throw new NotFoundException('Intent not found');
    const basis = await this.visibility(actor, intent);
    if (basis === 'own') {
      if (intent.status !== IntentStatus.Failed) {
        throw new ConflictException('Only failed intents can be retried');
      }
      return toDto(await this.intents.retry(intentId));
    }
    if (basis === 'none') throw new ForbiddenException('Intent is not owned by current user');
    return this.retryAsAdministrator(actor, intent);
  }

  /** Capability holders retry under a transaction that re-checks the capability. */
  private async retryAsAdministrator(actor: Actor, intent: IntentRecord) {
    const required = await this.administratorCapability(intent);
    if (!required) throw new NotFoundException('Intent not found');
    try {
      return await this.access.runWithActorCapabilities(
        actor.userId,
        [required],
        async (transaction) => {
          const current = await this.intents.findById(intent.id, transaction);
          if (!current) throw new NotFoundException('Intent not found');
          if (await this.administratorCapability(current) !== required) {
            throw new NotFoundException('Intent not found');
          }
          if (current.status !== IntentStatus.Failed) {
            throw new ConflictException('Only failed intents can be retried');
          }
          return toDto(await this.intents.retry(intent.id, transaction));
        },
      );
    } catch (error) {
      if (error instanceof ForbiddenException) throw new NotFoundException('Intent not found');
      throw error;
    }
  }

  private async listMine(
    actor: Actor,
    options: IntentListOptions,
    resourceIds: string[] | undefined,
  ) {
    if (!resourceIds) {
      return this.intents.list({ ...options, requestedBy: actor.userId });
    }
    const authorities = await this.registry.forResource(options.resourceType!)
      ?.resourceAuthorities(resourceIds);
    if (!resourceIds.every((id) => authorities?.get(id)?.ownerId === actor.userId)) {
      throw new NotFoundException('Resource not found');
    }
    return this.intents.list(options);
  }

  private async listAll(
    actor: Actor,
    options: IntentListOptions,
    resourceIds: string[] | undefined,
  ) {
    if (!holdsAny(actor, ADMIN_INTENT_CAPABILITIES)) {
      throw new ForbiddenException('scope=all requires an administrator capability');
    }
    if (resourceIds) {
      const authorities = await this.registry.forResource(options.resourceType!)
        ?.resourceAuthorities(resourceIds);
      const fallback = typeCapability(options.resourceType!);
      const allowed = resourceIds.every((id) => {
        const required = authorities?.get(id)?.adminCapability ?? fallback;
        return required != null && actor.capabilities.has(required);
      });
      if (!allowed) throw new ForbiddenException('The actor does not hold the required capabilities');
      return this.intents.list(options);
    }
    const allowedTypes = (Object.values(IntentResourceType) as IntentRecord['resourceType'][])
      .filter((type) => {
        if (type === IntentResourceType.Volume) {
          return actor.capabilities.has(Capability.ManageVolumes)
            || actor.capabilities.has(Capability.ManageSharedVolumes);
        }
        const required = typeCapability(type);
        return required != null && actor.capabilities.has(required);
      });
    if (options.resourceType && !allowedTypes.includes(options.resourceType)) {
      return { items: [], nextCursor: null };
    }
    const page = await this.intents.list({
      ...options,
      resourceTypes: options.resourceType ? undefined : allowedTypes,
    });
    return { items: await this.filterVolumeIntents(actor, page.items), nextCursor: page.nextCursor };
  }

  private async assertVisible(actor: Actor, intent: IntentRecord): Promise<void> {
    if (await this.visibility(actor, intent) === 'none') {
      throw new ForbiddenException('Intent is not owned by current user');
    }
  }

  /**
   * `own`: requested by the actor, owned by the actor, or governed by the
   * type-level capability. `administrator`: only the row-specific capability
   * (a shared volume's `ManageSharedVolumes`) grants access.
   */
  private async visibility(
    actor: Actor,
    intent: IntentRecord,
  ): Promise<'own' | 'administrator' | 'none'> {
    if (intent.requestedBy === actor.userId) return 'own';
    const fallback = typeCapability(intent.resourceType);
    if (fallback && actor.capabilities.has(fallback)) return 'own';
    const authority = (await this.registry.forResource(intent.resourceType)
      ?.resourceAuthorities([intent.resourceId]))?.get(intent.resourceId);
    if (authority?.ownerId === actor.userId) return 'own';
    if (authority?.adminCapability && actor.capabilities.has(authority.adminCapability)) {
      return 'administrator';
    }
    return 'none';
  }

  private async administratorCapability(intent: IntentRecord): Promise<Capability | null> {
    if (intent.resourceType !== IntentResourceType.Volume) {
      return typeCapability(intent.resourceType);
    }
    const authorities = await this.registry.forResource(intent.resourceType)
      ?.resourceAuthorities([intent.resourceId]);
    return authorities?.get(intent.resourceId)?.adminCapability
      ?? typeCapability(intent.resourceType);
  }

  private async filterVolumeIntents(
    actor: Actor,
    items: readonly IntentRecord[],
  ): Promise<IntentRecord[]> {
    const volumeIds = items
      .filter((item) => item.resourceType === IntentResourceType.Volume)
      .map((item) => item.resourceId);
    if (volumeIds.length === 0) return [...items];
    const authorities = await this.registry.forResource(IntentResourceType.Volume)
      ?.resourceAuthorities(volumeIds);
    return items.filter((item) => {
      if (item.resourceType !== IntentResourceType.Volume) return true;
      const required = authorities?.get(item.resourceId)?.adminCapability
        ?? Capability.ManageVolumes;
      return actor.capabilities.has(required);
    });
  }
}

const MAX_RESOURCE_IDS = 100;
