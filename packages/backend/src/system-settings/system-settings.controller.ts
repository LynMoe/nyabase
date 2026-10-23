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
import { Public, RequireRole, CurrentUser, CurrentActor } from '../iam/decorators.js';
import { hasRole, type Actor } from '../iam/actor.js';
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
  @RequireRole(Role.Operator)
  getSettings(@CurrentActor() actor: Actor): SystemSettingsDto {
    return this.systemSettingsDto(actor);
  }

  @Patch('admin/system-settings')
  @RequireRole(Role.Operator)
  async patchSettings(
    @CurrentUser() actor: UserRecord,
    @CurrentActor() caller: Actor,
    @Body() body: unknown,
  ): Promise<SystemSettingsDto> {
    const { values, expectedRevision } = zPatchSystemSettingsRequest.parse(body);
    try {
      const committed = await this.accessResolver.runWithActorRole(
        actor.id,
        Role.Operator,
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
          current: this.systemSettingsDto(caller),
        });
      }
      throw error;
    }
    return this.systemSettingsDto(caller);
  }

  private systemSettingsDto(caller: Actor): SystemSettingsDto {
    const admin = hasRole(caller, Role.Admin);
    const fields = this.config.allFields().map((field) =>
      field.adminOnly && !admin ? { ...field, editable: false } : field);
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
