import {
  Controller,
  Body,
  ConflictException,
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
  zRetryIntentRequest,
} from '@nyabase/common';
import { RequireAnyCaps } from '../iam/decorators/require-caps.decorator.js';
import { CurrentUser } from '../iam/decorators/current-user.decorator.js';
import type { UserRecord } from '../iam/user-record.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import { adminIntentListOptions, toDto } from './intent-dto.js';
import { IntentRepository, type IntentRecord } from './intent.repository.js';
import { ReconcilerRegistry } from './reconciler-registry.service.js';

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

@Controller('admin/intents')
@RequireAnyCaps(...ADMIN_INTENT_CAPABILITIES)
export class AdminIntentsController {
  constructor(
    private readonly intents: IntentRepository,
    private readonly access: AccessResolverService,
    private readonly registry: ReconcilerRegistry,
  ) {}

  @Get()
  async list(@Query() query: Record<string, unknown>, @CurrentUser() user: UserRecord) {
    const allowedTypes = await this.allowedResourceTypes(user.id);
    if (allowedTypes.length === 0) {
      return { items: [], nextCursor: null };
    }
    const options = adminIntentListOptions(query);
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
    const authorities = await this.registry.forResource(intent.resourceType)
      ?.resourceAuthorities([intent.resourceId]);
    return authorities?.get(intent.resourceId)?.adminCapability
      ?? adminCapabilityForIntent(intent.resourceType);
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
    const authorities = await this.registry.forResource(IntentResourceType.Volume)
      ?.resourceAuthorities(volumeIds);
    return items.filter((item) => {
      if (item.resourceType !== IntentResourceType.Volume) return true;
      const required = authorities?.get(item.resourceId)?.adminCapability
        ?? Capability.ManageVolumes;
      return capabilities.has(required);
    });
  }
}

@Controller('intents')
export class IntentsController {
  constructor(
    private readonly intents: IntentRepository,
    private readonly access: AccessResolverService,
    private readonly registry: ReconcilerRegistry,
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
      const authorities = await this.registry.forResource(intent.resourceType)
        ?.resourceAuthorities([intent.resourceId]);
      if (authorities?.get(intent.resourceId)?.ownerId === user.id) {
        return;
      }
    }

    throw new ForbiddenException('Intent is not owned by current user');
  }
}
