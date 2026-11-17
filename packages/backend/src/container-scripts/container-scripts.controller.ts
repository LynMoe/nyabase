import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  StreamableFile,
} from '@nestjs/common';
import type { Readable } from 'node:stream';
import {
  CONTAINER_SCRIPT_MAX_FILE_BYTES,
  FailureCode,
  Role,
  zContainerScriptActionRequest,
  zCreateContainerScriptRequest,
  zListContainerScriptRunsQuery,
  zListContainerScriptTargetsQuery,
  zListScope,
  zPatchContainerScriptRequest,
  zPreviewContainerScriptRequest,
  zPublishContainerScriptRequest,
  zRetryContainerScriptRequest,
} from '@nyabase/common';
import type { Actor } from '../iam/actor.js';
import type { UserRecord } from '../iam/auth-persistence.js';
import { CurrentActor, CurrentUser, RequireRole } from '../iam/decorators.js';
import { ContainerMaintenanceService } from './container-maintenance.service.js';
import { ContainerScriptsService } from './container-scripts.service.js';

type RawRequest = Readable & {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body?: unknown;
};

function tooLarge(): PayloadTooLargeException {
  return new PayloadTooLargeException({
    code: FailureCode.ContainerScriptTooLarge,
    message: `A file may be at most ${CONTAINER_SCRIPT_MAX_FILE_BYTES} bytes`,
    details: { maxBytes: CONTAINER_SCRIPT_MAX_FILE_BYTES },
  });
}

/**
 * The request body as bytes, at most `limit` of them. Only this route reads
 * raw bodies: the JSON parser leaves `application/octet-stream` unread.
 */
export async function readRawBody(request: RawRequest, limit: number): Promise<Buffer> {
  const type = String(request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/octet-stream') {
    throw new BadRequestException({
      code: FailureCode.InvalidInput,
      message: 'Send the file content as application/octet-stream',
    });
  }
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.byteLength;
    if (size > limit) {
      request.destroy();
      throw tooLarge();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

@Controller('admin/container-scripts')
@RequireRole(Role.Admin)
export class AdminContainerScriptsController {
  constructor(private readonly service: ContainerScriptsService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Post('blobs')
  async upload(@CurrentUser() user: UserRecord, @Req() request: RawRequest) {
    return this.service.uploadBlob(user.id, await readRawBody(request, CONTAINER_SCRIPT_MAX_FILE_BYTES));
  }

  @Get('blobs/:fingerprint')
  async download(@Param('fingerprint') sha256: string) {
    return new StreamableFile(await this.service.blob(sha256), {
      type: 'application/octet-stream',
      disposition: `attachment; filename="${sha256}"`,
    });
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(@Body() body: unknown) {
    return this.service.preview(zPreviewContainerScriptRequest.parse(body).scope);
  }

  @Post()
  create(@CurrentUser() user: UserRecord, @Body() body: unknown) {
    return this.service.create(user.id, zCreateContainerScriptRequest.parse(body));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Patch(':id')
  patch(@CurrentUser() user: UserRecord, @Param('id') id: string, @Body() body: unknown) {
    return this.service.patch(user.id, id, zPatchContainerScriptRequest.parse(body));
  }

  @Get(':id/versions')
  versions(@Param('id') id: string) {
    return this.service.versions(id);
  }

  @Post(':id/versions')
  publish(@CurrentUser() user: UserRecord, @Param('id') id: string, @Body() body: unknown) {
    return this.service.publish(user.id, id, zPublishContainerScriptRequest.parse(body));
  }

  @Get(':id/versions/:version')
  version(@Param('id') id: string, @Param('version') version: string) {
    return this.service.version(id, Number(version));
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  pause(@CurrentUser() user: UserRecord, @Param('id') id: string, @Body() body: unknown) {
    return this.service.pause(user.id, id, zContainerScriptActionRequest.parse(body).expectedRevision);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  resume(@CurrentUser() user: UserRecord, @Param('id') id: string, @Body() body: unknown) {
    return this.service.resume(user.id, id, zContainerScriptActionRequest.parse(body).expectedRevision);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  archive(@CurrentUser() user: UserRecord, @Param('id') id: string, @Body() body: unknown) {
    return this.service.archive(user.id, id, zContainerScriptActionRequest.parse(body).expectedRevision);
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  retry(@CurrentUser() user: UserRecord, @Param('id') id: string, @Body() body: unknown) {
    return this.service.retry(user.id, id, zRetryContainerScriptRequest.parse(body ?? {}));
  }

  @Get(':id/targets')
  targets(@Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.service.listTargets(id, zListContainerScriptTargetsQuery.parse(query));
  }

  @Get(':id/runs')
  runs(@Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.service.listRuns(id, zListContainerScriptRunsQuery.parse(query));
  }

  @Get(':id/runs/:runId')
  run(@Param('id') id: string, @Param('runId') runId: string) {
    return this.service.getRun(id, runId);
  }
}

/**
 * What a container's owner sees of the scripts that ran in it (staff with
 * `?scope=all`): names, state and when, never the script or its output.
 */
@Controller('containers')
export class ContainerMaintenanceController {
  constructor(private readonly maintenance: ContainerMaintenanceService) {}

  @Get(':containerId/maintenance')
  list(@Param('containerId') id: string, @CurrentActor() actor: Actor, @Query('scope') scope?: string) {
    return this.maintenance.list(actor, id, zListScope.parse(scope));
  }
}
