import {
  Body,
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
import { SshProxyGateway } from '../ssh/ssh-proxy-gateway.js';
import { postCommitBestEffort } from '../common/post-commit.js';

@Controller()
export class SystemSettingsController {
  constructor(
    private config: NyabaseConfigService,
    private sshProxyGateway: SshProxyGateway,
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
  async patchSettings(@Body() body: unknown): Promise<SystemSettingsDto> {
    const { values } = zPatchSystemSettingsRequest.parse(body);
    await this.config.updateEditable(values);
    await postCommitBestEffort(
      'System settings SSH snapshot broadcast',
      () => this.sshProxyGateway.broadcastSnapshot(),
    );
    return this.systemSettingsDto();
  }

  private systemSettingsDto(): SystemSettingsDto {
    const fields = this.config.allFields();
    return {
      configFile: this.config.configFile(),
      fields,
      editable: fields.filter((field) => field.editable),
      readOnly: fields.filter((field) => !field.editable),
      publicSettings: this.config.publicSettings(),
    };
  }
}
