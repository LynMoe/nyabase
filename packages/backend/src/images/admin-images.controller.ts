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
  UseGuards,
} from '@nestjs/common';
import {
  Capability,
  zAddCatalogImageRequest,
  zIntentListQuery,
  zPatchImageRequest,
  zPutImageAssignmentRequest,
} from '@nyabase/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { acceptedIntent } from '../domain/domain-utils.js';
import { ImagesService } from './images.service.js';

@Controller('admin/images')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageImages)
export class AdminImagesController {
  constructor(private readonly images: ImagesService) {}

  @Get()
  list(@Query('activeOnly') activeOnly?: string) {
    return this.images.findAllAdmin(activeOnly === 'true');
  }

  @Get('catalog')
  catalog() {
    return this.images.listCatalog();
  }

  @Post()
  create(@Body() body: unknown, @CurrentUser() actor: UserRecord) {
    return this.images.addFromCatalog(actor.id, zAddCatalogImageRequest.parse(body));
  }

  @Post(':id/repull')
  @HttpCode(HttpStatus.ACCEPTED)
  async repull(@Param('id') id: string, @CurrentUser() actor: UserRecord) {
    const result = await this.images.repull(actor.id, id);
    return {
      image: result.image,
      intents: result.intents.map(acceptedIntent),
    };
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.images.findAdminDtoById(id);
  }

  @Get(':id/status')
  async status(@Param('id') id: string) {
    return this.images.getServerStatuses(await this.images.findById(id));
  }

  @Get(':id/assignments')
  assignments(@Param('id') id: string) {
    return this.images.assignments(id).then((rows) =>
      rows.map((row) => ({
        id: row.id,
        imageId: row.image_id,
        serverId: row.server_id,
        generation: row.generation,
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
  async statusAssignments(@Param('id') id: string) {
    return this.images.getServerStatuses(await this.images.findById(id));
  }

  @Get(':id/intents')
  intents(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.images.listAssignmentIntents(id, undefined, zIntentListQuery.parse(query));
  }

  @Get(':id/assignments/:serverId/intents')
  assignmentIntents(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.images.listAssignmentIntents(id, serverId, zIntentListQuery.parse(query));
  }

  @Put(':id/assignments/:serverId')
  @HttpCode(HttpStatus.ACCEPTED)
  async ensureAssignment(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @CurrentUser() actor: UserRecord,
    @Body() body: unknown,
  ) {
    const input = zPutImageAssignmentRequest.parse(body);
    const result = await this.images.ensureAssignment(
      actor.id,
      id,
      serverId,
      input.expectedGeneration,
    );
    return {
      assignment: result.assignment,
      intent: acceptedIntent(result.intent),
    };
  }

  @Delete(':id/assignments/:serverId')
  @HttpCode(HttpStatus.ACCEPTED)
  async deleteAssignment(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @CurrentUser() actor: UserRecord,
    @Query('expectedGeneration') expectedGeneration?: string,
  ) {
    const generation = expectedGeneration === undefined
      ? undefined
      : Number(expectedGeneration);
    if (
      generation !== undefined
      && (!Number.isSafeInteger(generation) || generation < 1)
    ) {
      throw new BadRequestException('expectedGeneration must be a positive integer');
    }
    const result = await this.images.deleteAssignment(
      actor.id,
      id,
      serverId,
      generation,
    );
    return {
      assignment: result.assignment,
      intents: result.intents.map(acceptedIntent),
    };
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() actor: UserRecord,
  ) {
    return this.images.update(actor.id, id, zPatchImageRequest.parse(body));
  }

  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser() actor: UserRecord) {
    return this.images.delete(actor.id, id);
  }
}
