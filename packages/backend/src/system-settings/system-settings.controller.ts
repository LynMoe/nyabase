import {
  Body,
  ConflictException,
  Controller,
  Get,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  Capability,
  zPatchSystemSettingsRequest,
  type PublicSettingsDto,
  type SystemSettingsDto,
} from '@nyabase/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import {
  SystemSettingsAuthorityService,
  SystemSettingsRevisionConflictError,
} from './system-settings-authority.service.js';

@Controller()
export class SystemSettingsController {
  constructor(
    private config: NyabaseConfigService,
    private accessResolver: AccessResolverService,
    private authority: SystemSettingsAuthorityService,
  ) {}

  @Get('public/settings')
  publicSettings(): PublicSettingsDto {
    return this.config.publicSettings();
  }

  @Get('admin/system-settings')
  @UseGuards(JwtAuthGuard, CapabilitiesGuard)
  @RequireCaps(Capability.ManageSystemSettings)
  async getSettings(): Promise<SystemSettingsDto> {
    await this.authority.refreshFromPostgres('admin-read');
    return this.systemSettingsDto();
  }

  @Patch('admin/system-settings')
  @UseGuards(JwtAuthGuard, CapabilitiesGuard)
  @RequireCaps(Capability.ManageSystemSettings)
  async patchSettings(
    @CurrentUser() actor: UserRecord,
    @Body() body: unknown,
  ): Promise<SystemSettingsDto> {
    const { values, expectedRevision, expectedSnapshotToken } = zPatchSystemSettingsRequest.parse(body);
    try {
      const committed = await this.accessResolver.runWithActorCapabilities(
        actor.id,
        [Capability.ManageSystemSettings],
        (transaction) => this.authority.update(
          transaction,
          actor.id,
          values,
          expectedRevision,
          expectedSnapshotToken,
        ),
      );
      await this.authority.committed(committed);
    } catch (error) {
      if (error instanceof SystemSettingsRevisionConflictError) {
        this.authority.acceptConflict(error.current);
        throw new ConflictException({
          code: 'SYSTEM_SETTINGS_REVISION_CONFLICT',
          message: 'System settings changed; reload and resolve the conflicting fields',
          current: this.systemSettingsDto(),
        });
      }
      throw error;
    }
    return this.systemSettingsDto();
  }

  private systemSettingsDto(): SystemSettingsDto {
    const fields = this.config.allFields();
    return {
      revision: this.config.revision(),
      snapshotToken: this.config.snapshotToken(),
      configFile: this.config.configFile(),
      fields,
      editable: fields.filter((field) => field.editable),
      readOnly: fields.filter((field) => !field.editable),
      publicSettings: this.config.publicSettings(),
    };
  }
}
