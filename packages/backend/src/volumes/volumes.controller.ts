import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  Role,
  zListScope,
  zListSharedVolumesQuery,
  zListVolumesQuery,
  zStorageMountPreviewRequest,
} from '@nyabase/common';
import { CurrentActor, RequireRole } from '../iam/decorators.js';
import type { Actor } from '../iam/actor.js';
import { SharedVolumeCatalogInspectService } from './shared-volume-catalog.service.js';
import { VolumeProvisioner } from './volume-provisioner.service.js';
import { VolumesService } from './volumes.service.js';

/**
 * Local volumes, read-only: the platform creates, sizes and mounts them.
 * Owners and admins share one surface; admins see others' rows with `?scope=all`.
 */
@Controller('volumes')
export class VolumesController {
  constructor(private readonly service: VolumesService) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query() query: Record<string, unknown>) {
    return this.service.list(actor, zListVolumesQuery.parse(query));
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentActor() actor: Actor, @Query('scope') scope?: string) {
    return this.service.get(actor, id, zListScope.parse(scope));
  }

  /** A volume no grant covers any more (user admins). */
  @Delete(':id')
  @RequireRole(Role.UserAdmin)
  @HttpCode(HttpStatus.ACCEPTED)
  delete(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.service.delete(actor, id, 'local');
  }
}

@Controller('servers/:serverId/storage-capacity')
export class StorageCapacityController {
  constructor(private readonly service: VolumesService) {}

  /** `scope=mine` is the caller's grant view; `scope=all` is server-wide (user admin). */
  @Get()
  get(
    @Param('serverId') serverId: string,
    @CurrentActor() actor: Actor,
    @Query('scope') scope?: string,
  ) {
    return this.service.capacity(actor, serverId, zListScope.parse(scope));
  }
}

/** What enabling a disk at a mount path would do now: the volumes created, the containers mounted into. */
@Controller()
export class StorageMountPreviewController {
  constructor(private readonly provisioner: VolumeProvisioner) {}

  @Post('servers/:serverId/storage-pools/:poolId/mount-preview')
  @RequireRole(Role.Admin)
  @HttpCode(HttpStatus.OK)
  pool(@Param('serverId') serverId: string, @Param('poolId') poolId: string, @Body() body: unknown) {
    const { mountPath } = zStorageMountPreviewRequest.parse(body);
    return this.provisioner.preview({ kind: 'pool', id: poolId, serverId }, mountPath);
  }

  @Post('shared-backends/:backendId/mount-preview')
  @RequireRole(Role.Admin)
  @HttpCode(HttpStatus.OK)
  backend(@Param('backendId') backendId: string, @Body() body: unknown) {
    const { mountPath } = zStorageMountPreviewRequest.parse(body);
    return this.provisioner.preview({ kind: 'backend', id: backendId }, mountPath);
  }
}

/** Shared volumes, read-only (the platform creates, sizes and mounts them); admins see others' rows with `?scope=all`. */
@Controller('shared-volumes')
export class SharedVolumesController {
  constructor(
    private readonly service: VolumesService,
    private readonly inspector: SharedVolumeCatalogInspectService,
  ) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query() query: Record<string, unknown>) {
    return this.service.listShared(actor, zListSharedVolumesQuery.parse(query));
  }

  @Get(':id/catalogs')
  @RequireRole(Role.Admin)
  inspect(@Param('id') id: string) {
    return this.inspector.inspectSharedVolumeCatalogs(id);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentActor() actor: Actor, @Query('scope') scope?: string) {
    return this.service.getShared(actor, id, zListScope.parse(scope));
  }

  /** A volume no grant covers any more (user admins). */
  @Delete(':id')
  @RequireRole(Role.UserAdmin)
  @HttpCode(HttpStatus.ACCEPTED)
  delete(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.service.delete(actor, id, 'shared');
  }
}

@Controller('shared-backends')
export class SharedBackendCatalogInspectController {
  constructor(private readonly inspector: SharedVolumeCatalogInspectService) {}

  @Get(':id/catalog-inspect')
  @RequireRole(Role.Admin)
  inspect(@Param('id') id: string) {
    return this.inspector.inspectSharedBackendCatalogs(id);
  }
}
