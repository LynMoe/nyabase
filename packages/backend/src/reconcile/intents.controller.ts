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
  IntentResourceType,
  IntentStatus,
  Role,
  zIntentListQuery,
  zListScope,
  zRetryIntentRequest,
  type IntentDto,
} from '@nyabase/common';
import { CurrentActor } from '../iam/decorators.js';
import { hasRole, type Actor, requireUserId } from '../iam/actor.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import { IntentRepository, type IntentListOptions, type IntentRecord } from './intent.repository.js';
import { ReconcilerRegistry } from './reconciler-registry.service.js';

function toDto(intent: IntentRecord): IntentDto {
  return {
    id: intent.id,
    kind: intent.kind as IntentDto['kind'],
    resourceType: intent.resourceType as IntentDto['resourceType'],
    resourceId: intent.resourceId,
    serverId: intent.serverId,
    requestedBy: intent.requestedBy,
    requestSummary: intent.request ?? {},
    targetRevision: intent.targetRevision,
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
  };
}

/** The minimum role that governs a resource type's intents. */
function typeRole(resourceType: IntentRecord['resourceType']): Role | null {
  switch (resourceType) {
    case IntentResourceType.Container:
      return Role.Operator;
    case IntentResourceType.Volume:
      return Role.Admin;
    case IntentResourceType.Server:
      return Role.Operator;
    case IntentResourceType.ImageAssignment:
      return Role.Operator;
    default:
      return null;
  }
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * The only intents surface. By default (`scope=mine`) an intent's detail and
 * retry follow the owner of its resource, whatever your role (an intent you
 * issued on someone else's resource still needs the governing role); the list
 * shows what you requested. `?scope=all` is the explicit override and needs
 * the role that governs the intent's resource type.
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
  async get(
    @Param('intentId') intentId: string,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    const intent = await this.intents.findById(intentId);
    if (!intent) throw new NotFoundException('Intent not found');
    await this.basis(actor, intent, zListScope.parse(scope));
    return toDto(intent);
  }

  @Post(':intentId/retry')
  async retry(
    @Param('intentId') intentId: string,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Query('scope') scope?: string,
  ) {
    zRetryIntentRequest.parse(body);
    const intent = await this.intents.findById(intentId);
    if (!intent) throw new NotFoundException('Intent not found');
    const basis = await this.basis(actor, intent, zListScope.parse(scope));
    if (basis === 'own') {
      if (intent.status !== IntentStatus.Failed) {
        throw new ConflictException('Only failed intents can be retried');
      }
      return toDto(await this.intents.retry(intentId));
    }
    return this.retryAsAdministrator(actor, intent);
  }

  /** `scope=all` retries run under a transaction that re-checks the role. */
  private async retryAsAdministrator(actor: Actor, intent: IntentRecord) {
    const required = typeRole(intent.resourceType);
    if (!required) throw new NotFoundException('Intent not found');
    try {
      return await this.access.runWithActorRole(
        requireUserId(actor),
        required,
        async (transaction) => {
          const current = await this.intents.findById(intent.id, transaction);
          if (!current) throw new NotFoundException('Intent not found');
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
      const page = await this.intents.list({ ...options, requestedBy: requireUserId(actor) });
      return { ...page, items: await this.visibleToRequester(actor, page.items) };
    }
    const authorities = await this.registry.forResource(options.resourceType!)
      ?.resourceAuthorities(resourceIds);
    if (!resourceIds.every((id) => authorities?.get(id)?.ownerId === actor.userId)) {
      throw new NotFoundException('Resource not found');
    }
    return this.intents.list(options);
  }

  /**
   * What you requested, minus intents you could no longer open: one against a
   * resource you do not own needs the type's role now, as `basis` does.
   */
  private async visibleToRequester<T extends Pick<IntentRecord, 'resourceType' | 'resourceId'>>(
    actor: Actor,
    items: readonly T[],
  ): Promise<T[]> {
    const foreignTypes = new Map<IntentRecord['resourceType'], string[]>();
    for (const item of items) {
      const required = typeRole(item.resourceType);
      if (required != null && hasRole(actor, required)) continue;
      foreignTypes.set(item.resourceType, [...(foreignTypes.get(item.resourceType) ?? []), item.resourceId]);
    }
    const hidden = new Set<string>();
    for (const [type, ids] of foreignTypes) {
      const authorities = await this.registry.forResource(type)?.resourceAuthorities([...new Set(ids)]);
      for (const id of ids) {
        const authority = authorities?.get(id);
        // Same rule as `basis`: a deleted resource's intents stay visible to the requester.
        if (authority !== undefined && authority.ownerId !== actor.userId) hidden.add(`${type}:${id}`);
      }
    }
    return items.filter((item) => !hidden.has(`${item.resourceType}:${item.resourceId}`));
  }

  private async listAll(
    actor: Actor,
    options: IntentListOptions,
    resourceIds: string[] | undefined,
  ) {
    if (!hasRole(actor, Role.Operator)) {
      throw new ForbiddenException('scope=all requires the operator role');
    }
    if (resourceIds) {
      const required = typeRole(options.resourceType!);
      if (required == null || !hasRole(actor, required)) {
        throw new ForbiddenException('The actor does not hold the required role');
      }
      return this.intents.list(options);
    }
    // `?serverId=` for an operator: every intent on that server, whatever its
    // resource type.
    if (options.serverId && hasRole(actor, Role.Operator)) {
      const page = await this.intents.list(options);
      return { items: page.items, nextCursor: page.nextCursor };
    }
    const allowedTypes = (Object.values(IntentResourceType) as IntentRecord['resourceType'][])
      .filter((type) => {
        const required = typeRole(type);
        return required != null && hasRole(actor, required);
      });
    if (options.resourceType && !allowedTypes.includes(options.resourceType)) {
      return { items: [], nextCursor: null };
    }
    const page = await this.intents.list({
      ...options,
      resourceTypes: options.resourceType ? undefined : allowedTypes,
    });
    return page;
  }

  /**
   * Why the actor may see or retry the intent. `own`: they own its resource
   * (any role). `administrator`: `scope=all`, or an intent they issued against
   * a resource they do not own (an earlier admin override, or an operator-only
   * resource) — both need the role that governs the resource type *now*, so a
   * demoted operator keeps no access through intents they once requested.
   * Anything else is a 404 (403 for `scope=all` without the role).
   */
  private async basis(
    actor: Actor,
    intent: IntentRecord,
    scope: 'mine' | 'all',
  ): Promise<'own' | 'administrator'> {
    const required = typeRole(intent.resourceType);
    const holdsRole = required != null && hasRole(actor, required);
    if (scope === 'all') {
      if (!holdsRole) throw new ForbiddenException('The actor does not hold the required role');
      return 'administrator';
    }
    const authority = (await this.registry.forResource(intent.resourceType)
      ?.resourceAuthorities([intent.resourceId]))?.get(intent.resourceId);
    if (authority?.ownerId != null && authority.ownerId === actor.userId) return 'own';
    // A deleted resource has no owner left to ask; its history (e.g. the
    // delete itself) stays with whoever requested it. Retrying it is a no-op.
    if (authority === undefined && intent.requestedBy === actor.userId) return 'own';
    if (intent.requestedBy === actor.userId && holdsRole) return 'administrator';
    throw new NotFoundException('Intent not found');
  }
}

const MAX_RESOURCE_IDS = 100;
