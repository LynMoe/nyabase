import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { dirname } from 'path';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { stringify as stringifyYaml } from 'yaml';
import {
  controlPlaneConfigDefinitions,
  getControlPlaneConfigDefinition,
  type ConfigSourceName,
  type ControlPlaneConfigKey,
  type PublicSettingsDto,
  type SystemSettingFieldDto,
} from '@nyabase/common';
import {
  loadNyabaseConfig,
  type LoadedNyabaseConfig,
  type ResolvedConfigField,
} from './nyabase-config-loader.js';

const HIDDEN_SECRET = '********';

@Injectable()
export class NyabaseConfigService implements OnModuleInit {
  private snapshot: LoadedNyabaseConfig = loadNyabaseConfig();

  onModuleInit(): void {
    this.validateProductionSecrets();
  }

  reload(): LoadedNyabaseConfig {
    this.snapshot = loadNyabaseConfig();
    this.validateProductionSecrets();
    return this.snapshot;
  }

  configFile(): string {
    return this.snapshot.configFile;
  }

  field<T = unknown>(key: ControlPlaneConfigKey): ResolvedConfigField<T> {
    return this.snapshot.fields[key] as ResolvedConfigField<T>;
  }

  get<T = unknown>(key: ControlPlaneConfigKey): T {
    return this.field<T>(key).effectiveValue;
  }

  source(key: ControlPlaneConfigKey): ConfigSourceName {
    return this.field(key).source;
  }

  allFields(): SystemSettingFieldDto[] {
    return controlPlaneConfigDefinitions.map((definition) => {
      const resolved = this.snapshot.fields[definition.key];
      return {
        key: definition.key,
        yamlPath: definition.yamlPath,
        env: definition.env,
        valueKind: definition.valueKind,
        effectiveValue: maskIfSecret(definition.secret, resolved.effectiveValue),
        source: resolved.source,
        yamlValue: maskIfSecret(definition.secret, resolved.yamlValue),
        envValuePresent: resolved.envValuePresent,
        defaultValue: maskIfSecret(definition.secret, resolved.defaultValue),
        secret: definition.secret,
        editable: definition.editable && !definition.restartRequired,
        restartRequired: definition.restartRequired,
        public: definition.public,
        label: definition.label,
        description: definition.description,
      };
    });
  }

  publicSettings(): PublicSettingsDto {
    return {
      branding: {
        title: this.get<string>('branding.title'),
        description: this.get<string>('branding.description'),
      },
    };
  }

  async updateEditable(values: Record<string, unknown>): Promise<void> {
    const nextYaml = cloneObject(this.snapshot.rawYaml);

    for (const [key, rawValue] of Object.entries(values)) {
      const definition = getControlPlaneConfigDefinition(key);
      if (!definition) throw new BadRequestException(`Unknown config key: ${key}`);
      if (!definition.editable || definition.secret) {
        throw new BadRequestException(`Config key is not editable: ${key}`);
      }
      if (definition.restartRequired) {
        throw new BadRequestException(`Config key requires restart and cannot be edited online: ${key}`);
      }
      if (definition.env && process.env[definition.env] !== undefined && process.env[definition.env] !== '') {
        throw new BadRequestException(`Config key is overridden by environment: ${key}`);
      }
      const parsed = definition.schema.safeParse(rawValue);
      if (!parsed.success) {
        throw new BadRequestException(`Invalid config value for ${key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      }
      setByPath(nextYaml, definition.yamlPath, parsed.data);
    }

    writeYamlAtomic(this.snapshot.configFile, nextYaml);
    this.reload();
  }

  validateProductionSecrets(): void {
    if (
      this.get<string>('runtime.nodeEnv') === 'production'
      && this.get<string>('auth.jwtSecret') === 'change-me-in-production'
    ) {
      throw new Error('auth.jwtSecret must be set to a strong secret in production');
    }
  }
}

function maskIfSecret(secret: boolean, value: unknown): unknown {
  if (!secret) return value;
  if (value === undefined || value === null || value === '') return value;
  return HIDDEN_SECRET;
}

function cloneObject(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function setByPath(input: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor = input;
  for (const segment of segments.slice(0, -1)) {
    const current = cursor[segment];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
}

function writeYamlAtomic(path: string, value: Record<string, unknown>): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const content = stringifyYaml(value, { sortMapEntries: false });
  writeFileSync(tmpPath, content, { mode: 0o600 });
  renameSync(tmpPath, path);
}
