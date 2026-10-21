import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  Capability,
  zAddCatalogImageRequest,
  zListScope,
  zPatchImageRequest,
  zPutImageAssignmentRequest,
} from '@nyabase/common';
import { RequireCaps, CurrentActor } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { acceptedIntent } from '../reconcile/accepted-intent.js';
import { ImagesService } from './images.service.js';

/**
 * Images: every authenticated user lists the images they may use
 * (`scope=mine`); catalog, assignment and lifecycle operations are
 * `ManageImages` only.
 */
@Controller('images')
export class ImagesController {
  constructor(private readonly images: ImagesService) {}

  @Get()
  list(
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.images.list(actor, zListScope.parse(scope), activeOnly === 'true');
  }

  @Get('catalog')
  @RequireCaps(Capability.ManageImages)
  catalog() {
    return this.images.listCatalog();
  }

  @Post()
  @RequireCaps(Capability.ManageImages)
  create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.images.addFromCatalog(actor.userId, zAddCatalogImageRequest.parse(body));
  }

  @Post(':id/repull')
  @RequireCaps(Capability.ManageImages)
  @HttpCode(HttpStatus.ACCEPTED)
  async repull(@Param('id') id: string, @CurrentActor() actor: Actor) {
    const result = await this.images.repull(actor.userId, id);
    return {
      image: result.image,
      intents: result.intents.map(acceptedIntent),
    };
  }

  @Get(':id')
  get(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    return this.images.get(actor, id, zListScope.parse(scope));
  }

  @Get(':id/status')
  @RequireCaps(Capability.ManageImages)
  async status(@Param('id') id: string) {
    return this.images.getServerStatuses(await this.images.findById(id));
  }

  @Get(':id/assignments')
  @RequireCaps(Capability.ManageImages)
  assignments(@Param('id') id: string) {
    return this.images.assignments(id).then((rows) =>
      rows.map((row) => ({
        id: row.id,
        imageId: row.image_id,
        serverId: row.server_id,
        revision: row.revision,
        observedFingerprint: row.observed_fingerprint,
        managedFingerprint: row.managed_fingerprint,
        lifecyclePhase: row.lifecycle_phase,
        needsAttention: row.needs_attention,
        failureCode: row.failure_code,
        failureReason: row.failure_reason,
        lastObservedAt: row.last_observed_at
          ? new Date(row.last_observed_at).toISOString()
          : null,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      })),
    );
  }

  @Get(':id/assignments/status')
  @RequireCaps(Capability.ManageImages)
  async statusAssignments(@Param('id') id: string) {
    return this.images.getServerStatuses(await this.images.findById(id));
  }

  @Put(':id/assignments/:serverId')
  @RequireCaps(Capability.ManageImages)
  @HttpCode(HttpStatus.ACCEPTED)
  async ensureAssignment(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ) {
    const input = zPutImageAssignmentRequest.parse(body);
    const result = await this.images.ensureAssignment(
      actor.userId,
      id,
      serverId,
      input.expectedRevision,
    );
    return {
      assignment: result.assignment,
      intent: acceptedIntent(result.intent),
    };
  }

  @Delete(':id/assignments/:serverId')
  @RequireCaps(Capability.ManageImages)
  @HttpCode(HttpStatus.ACCEPTED)
  async deleteAssignment(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @CurrentActor() actor: Actor,
    @Query('expectedRevision') expectedRevision?: string,
  ) {
    const revision = expectedRevision === undefined
      ? undefined
      : Number(expectedRevision);
    if (
      revision !== undefined
      && (!Number.isSafeInteger(revision) || revision < 1)
    ) {
      throw new BadRequestException('expectedRevision must be a positive integer');
    }
    const result = await this.images.deleteAssignment(
      actor.userId,
      id,
      serverId,
      revision,
    );
    return {
      assignment: result.assignment,
      intents: result.intents.map(acceptedIntent),
    };
  }

  @Patch(':id')
  @RequireCaps(Capability.ManageImages)
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return this.images.update(actor.userId, id, zPatchImageRequest.parse(body));
  }

  @Delete(':id')
  @RequireCaps(Capability.ManageImages)
  delete(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.images.delete(actor.userId, id);
  }
}
