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
  AuditAction,
  zPatchSystemSettingsRequest,
  type PublicSettingsDto,
  type SystemSettingsDto,
} from '@nyabase/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import {
  NyabaseConfigService,
  SystemSettingsRevisionConflictError,
} from '../config/nyabase-config.service.js';
import { SshProxyGateway } from '../ssh/ssh-proxy-gateway.js';
import { postCommitBestEffort } from '../common/post-commit.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserEntity } from '../entities/user.entity.js';
import { AuditService } from '../audit/audit.service.js';
import { AccessResolverService } from '../access/access-resolver.service.js';

@Controller()
export class SystemSettingsController {
  constructor(
    private config: NyabaseConfigService,
    private sshProxyGateway: SshProxyGateway,
    private audit: AuditService,
    private accessResolver: AccessResolverService,
  ) {}

  @Get('public/settings')
  publicSettings(): PublicSettingsDto {
    return this.config.publicSettings();
  }

  @Get('admin/system-settings')
  @UseGuards(JwtAuthGuard, CapabilitiesGuard)
  @RequireCaps(Capability.ManageSystemSettings)
  async getSettings(): Promise<SystemSettingsDto> {
    return this.systemSettingsDto();
  }

  @Patch('admin/system-settings')
  @UseGuards(JwtAuthGuard, CapabilitiesGuard)
  @RequireCaps(Capability.ManageSystemSettings)
  async patchSettings(
    @CurrentUser() actor: UserEntity,
    @Body() body: unknown,
  ): Promise<SystemSettingsDto> {
    const { values, expectedRevision, expectedSnapshotToken } = zPatchSystemSettingsRequest.parse(body);
    try {
      const started = await this.accessResolver.startExternalWithActorCapabilities(
        actor.id,
        [Capability.ManageSystemSettings],
        () => this.config.updateEditable(values, expectedRevision, expectedSnapshotToken),
      );
      await started.completion;
    } catch (error) {
      if (error instanceof SystemSettingsRevisionConflictError) {
        throw new ConflictException({
          code: 'SYSTEM_SETTINGS_REVISION_CONFLICT',
          message: 'System settings changed; reload and resolve the conflicting fields',
          current: this.systemSettingsDto(),
        });
      }
      throw error;
    }
    await postCommitBestEffort(
      'System settings SSH snapshot broadcast',
      () => this.sshProxyGateway.broadcastSnapshot(),
    );
    await postCommitBestEffort(
      'System settings update audit',
      () => this.audit.log(actor.id, AuditAction.UpdateSystemSettings, 'control-plane', 'system_settings', {
        keys: Object.keys(values).sort(),
      }),
    );
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
