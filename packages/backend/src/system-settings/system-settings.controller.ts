import {
  Body,
  ConflictException,
  Controller,
  Get,
  Patch,
} from '@nestjs/common';
import {
  zPatchSystemSettingsRequest,
  type PublicSettingsDto,
  type SystemSettingsDto,
  Role,
} from '@nyabase/common';
import { Public, RequireRole, CurrentUser } from '../iam/decorators.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import type { UserRecord } from '../iam/auth-persistence.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
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

  @Public()
  @Get('public/settings')
  publicSettings(): PublicSettingsDto {
    return this.config.publicSettings();
  }

  @Get('admin/system-settings')
  @RequireRole(Role.Admin)
  getSettings(): SystemSettingsDto {
    return this.systemSettingsDto();
  }

  @Patch('admin/system-settings')
  @RequireRole(Role.Admin)
  async patchSettings(
    @CurrentUser() actor: UserRecord,
    @Body() body: unknown,
  ): Promise<SystemSettingsDto> {
    const { values, expectedRevision } = zPatchSystemSettingsRequest.parse(body);
    try {
      const committed = await this.accessResolver.runWithActorRole(
        actor.id,
        Role.Admin,
        (transaction) => this.authority.update(
          transaction,
          actor.id,
          values,
          expectedRevision,
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
      configFile: this.config.configFile(),
      fields,
      editable: fields.filter((field) => field.editable),
      readOnly: fields.filter((field) => !field.editable),
      publicSettings: this.config.publicSettings(),
    };
  }
}
