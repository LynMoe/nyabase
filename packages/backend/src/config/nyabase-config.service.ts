import { Injectable, OnModuleInit } from '@nestjs/common';
import { statSync } from 'node:fs';
import {
  controlPlaneConfigDefinitions,
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

export interface AuthoritativeSystemSettingsSnapshot {
  revision: number;
  snapshotToken: string;
  values: Record<string, unknown>;
}

/**
 * Deployment configuration is a read-only bootstrap and secret boundary.
 * Online-editable values are overlaid from PostgreSQL after migrations have
 * completed; this class never writes the deployment YAML.
 */
@Injectable()
export class NyabaseConfigService implements OnModuleInit {
  private snapshot: LoadedNyabaseConfig;
  private authoritative: AuthoritativeSystemSettingsSnapshot | null = null;
  private snapshotTokenValue: string;

  constructor() {
    this.snapshot = loadNyabaseConfig();
    this.snapshotTokenValue = '0'.repeat(64);
  }

  onModuleInit(): void {
    this.validateProductionSecrets();
  }

  /**
   * Reloads only deployment-owned configuration. A PostgreSQL overlay, once
   * established, remains the authority for online-editable settings.
   */
  reload(): LoadedNyabaseConfig {
    this.snapshot = loadNyabaseConfig();
    if (this.authoritative) this.applyAuthoritativeSnapshot(this.authoritative);
    this.validateProductionSecrets();
    return this.snapshot;
  }

  configFile(): string {
    return this.snapshot.configFile;
  }

  revision(): number {
    return this.authoritative?.revision ?? 1;
  }

  snapshotToken(): string {
    return this.authoritative?.snapshotToken ?? this.snapshotTokenValue;
  }

  field<T = unknown>(key: ControlPlaneConfigKey): ResolvedConfigField<T> {
    return this.snapshot.fields[key] as ResolvedConfigField<T>;
  }

  get<T = unknown>(key: ControlPlaneConfigKey): T {
    return this.field<T>(key).effectiveValue;
  }

  /**
   * Dedicated secret for SSH host keys, Incus client keys, and HTTP-proxy TLS
   * material. Production never falls back to auth.jwtSecret.
   */
  keyEncryptionSecret(): string {
    const dedicated = this.get<string>('ssh.keyEncryptionSecret')?.trim() ?? '';
    if (dedicated) return dedicated;
    if (this.get<string>('runtime.nodeEnv') === 'production') {
      throw new Error(
        'ssh.keyEncryptionSecret must be set to a dedicated secret in production',
      );
    }
    const fallback = this.get<string>('auth.jwtSecret')?.trim() ?? '';
    if (!fallback) {
      throw new Error('ssh.keyEncryptionSecret is empty and auth.jwtSecret is unavailable');
    }
    return fallback;
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
    const host = this.get<string>('ssh.proxyPublicHost')?.trim() ?? '';
    const port = this.get<number>('ssh.proxyPublicPort');
    return {
      branding: {
        title: this.get<string>('branding.title'),
        description: this.get<string>('branding.description'),
      },
      sshProxy: host && port ? { host, port } : null,
    };
  }

  /**
   * Values used exactly once when the PostgreSQL singleton is first created.
   * They preserve an existing deployment's editable YAML values during the
   * migration, while subsequent restarts always load PostgreSQL.
   */
  bootstrapEditableValues(): Record<string, unknown> {
    return Object.fromEntries(
      controlPlaneConfigDefinitions
        .filter(isOnlineEditable)
        .map((definition) => [
          definition.key,
          this.snapshot.fields[definition.key].effectiveValue,
        ]),
    );
  }

  applyAuthoritativeSnapshot(
    authoritative: AuthoritativeSystemSettingsSnapshot,
  ): boolean {
    if (
      !Number.isSafeInteger(authoritative.revision)
      || authoritative.revision < 1
      || !/^[a-f0-9]{64}$/.test(authoritative.snapshotToken)
    ) {
      throw new Error('Invalid PostgreSQL system settings snapshot');
    }
    if (
      this.authoritative
      && authoritative.revision < this.authoritative.revision
    ) {
      return false;
    }
    if (
      this.authoritative
      && authoritative.revision === this.authoritative.revision
      && (
        authoritative.snapshotToken !== this.authoritative.snapshotToken
        || JSON.stringify(authoritative.values)
          !== JSON.stringify(this.authoritative.values)
      )
    ) {
      throw new Error(
        `Conflicting PostgreSQL system settings snapshot at revision ${
          authoritative.revision
        }`,
      );
    }

    const nextFields = { ...this.snapshot.fields };
    for (const definition of controlPlaneConfigDefinitions) {
      if (!isOnlineEditable(definition)) continue;
      if (!Object.prototype.hasOwnProperty.call(
        authoritative.values,
        definition.key,
      )) {
        throw new Error(
          `PostgreSQL system settings snapshot is missing ${definition.key}`,
        );
      }
      const parsed = definition.schema.safeParse(
        authoritative.values[definition.key],
      );
      if (!parsed.success) {
        throw new Error(
          `Invalid PostgreSQL system setting ${definition.key}: ${
            parsed.error.issues.map((issue) => issue.message).join('; ')
          }`,
        );
      }
      const current = this.snapshot.fields[definition.key];
      // Environment overrides remain deployment-owned and cannot be edited.
      nextFields[definition.key] = current.envValuePresent
        ? current
        : {
          ...current,
          effectiveValue: parsed.data,
          source: 'database',
        };
    }

    this.snapshot = {
      ...this.snapshot,
      revision: authoritative.revision,
      fields: nextFields,
    };
    this.authoritative = {
      revision: authoritative.revision,
      snapshotToken: authoritative.snapshotToken,
      values: { ...authoritative.values },
    };
    this.snapshotTokenValue = authoritative.snapshotToken;
    return true;
  }

  validateProductionSecrets(): void {
    if (this.get<string>('runtime.nodeEnv') !== 'production') return;
    if (this.get<string>('auth.jwtSecret') === 'change-me-in-production') {
      throw new Error('auth.jwtSecret must be set to a strong secret in production');
    }
    const keySecret = this.get<string>('ssh.keyEncryptionSecret')?.trim() ?? '';
    if (!keySecret) {
      throw new Error(
        'ssh.keyEncryptionSecret must be set to a dedicated secret in production',
      );
    }
    this.assertProductionConfigFileMode();
  }

  private assertProductionConfigFileMode(): void {
    if (!this.snapshot.configFileIdentity.exists) return;
    const path = this.snapshot.configFile;
    const stat = statSync(path);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const groupOtherBits = stat.mode & 0o077;
    const ownerMismatch = uid !== undefined && stat.uid !== uid;
    if (groupOtherBits === 0 && !ownerMismatch) return;
    throw new Error(
      `Production config file ${path} must be owned by the backend uid`
      + (uid !== undefined ? ` (${uid})` : '')
      + ' and chmod 0400 (not group/other-accessible). '
      + 'chown it to the backend uid and chmod 0400.',
    );
  }
}

function isOnlineEditable(
  definition: (typeof controlPlaneConfigDefinitions)[number],
): boolean {
  return definition.editable
    && !definition.restartRequired
    && !definition.secret;
}

function maskIfSecret(secret: boolean, value: unknown): unknown {
  if (!secret) return value;
  if (value === undefined || value === null || value === '') return value;
  return HIDDEN_SECRET;
}
